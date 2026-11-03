import BoardKit
import Foundation
import Testing

#if canImport(UIKit)
  import UIKit
#endif

@testable import Stellaris

/// Images put in a draft over the fake board: each holds its place where the caret was, one a
/// line, until the board's markdown for it takes the place; bytes that hold no picture leave a
/// reason and no line, which the next post clears; and Send waits while one is on its way. Each
/// test signs in with a token of its own, which the fake board keeps its writes under.
@MainActor @Suite(.serialized) struct ComposerImageTests {
  private let general = Conversation.general
  private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])

  private func signedIn() async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: "upload-\(UUID().uuidString)")
    try await waitUntilLoaded(model)
    return model
  }

  @Test func anImageTakesThePlaceItHeldAtTheCaret() async throws {
    let model = try await signedIn()
    model.memory?.setDraft("Before  after", for: general)
    let held = model.holdImages(1, in: general, start: 7, end: 7)
    #expect(held.placeholder == "![Uploading image…]()")
    #expect(held.caret == 7 + held.placeholder.utf16.count)
    #expect(model.memory?.draft(general) == "Before ![Uploading image…]() after")
    #expect(model.uploading[general.key] == 1)

    await model.upload(png, holding: held.placeholder, in: general)
    let draft = try #require(model.memory?.draft(general))
    #expect(
      draft.wholeMatch(of: /Before !\[image\.png\]\(image:00000000000000000000PHT001\) after/)
        != nil, "\(draft)")
    #expect(model.uploading[general.key] == nil)
    #expect(model.uploadFailures[general.key] == nil)
  }

  @Test func whatHoldsNoPictureLeavesAReasonAndNoLine() async throws {
    let model = try await signedIn()
    model.memory?.setDraft("See: ", for: general)
    let held = model.holdImages(2, in: general, start: 5, end: 5)
    #expect(model.memory?.draft(general) == "See: \(held.placeholder)\n\(held.placeholder)")

    await model.upload(Data("<svg/>".utf8), holding: held.placeholder, in: general)
    #expect(model.uploadFailures[general.key] == "The image could not be read.")
    #expect(model.memory?.draft(general) == "See: \n\(held.placeholder)")
    #expect(model.uploading[general.key] == 1)
    // Photos or the pasteboard gave nothing at all.
    await model.upload(nil, holding: held.placeholder, in: general)
    #expect(model.memory?.draft(general) == "See: \n")
    #expect(model.uploading[general.key] == nil)

    // The next image clears the reason, and so does a post.
    _ = model.holdImages(1, in: general, start: 0, end: 0)
    #expect(model.uploadFailures[general.key] == nil)
    await model.upload(nil, holding: held.placeholder, in: general)
    #expect(model.uploadFailures[general.key] != nil)
    _ = try await model.post("Without it.", to: general)
    #expect(model.uploadFailures[general.key] == nil)
  }

  @Test func aLineTheUserDeletedTakesNoImage() async throws {
    let model = try await signedIn()
    let held = model.holdImages(1, in: general, start: 0, end: 0)
    model.memory?.setDraft("Changed my mind.", for: general)
    await model.upload(png, holding: held.placeholder, in: general)
    #expect(model.memory?.draft(general) == "Changed my mind.")
    #expect(model.uploading[general.key] == nil)
  }

  @Test func keepsWhatTheBoardTakesAsItIs() async throws {
    #expect(await ComposerImage.prepare(png) == ComposerImage(data: png, type: .png))
    let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 16])
    #expect(await ComposerImage.prepare(jpeg)?.name == "image.jpeg")
    #expect(await ComposerImage.prepare(Data("<svg/>".utf8)) == nil)
  }

  #if canImport(UIKit)
    /// A picture past the limit goes as a JPEG, scaled down until it fits.
    @Test func makesAPictureTooLargeIntoAJPEGThatFits() async throws {
      let size = CGSize(width: 600, height: 400)
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let large = UIGraphicsImageRenderer(size: size, format: format).pngData { context in
        for x in stride(from: 0, to: 600, by: 3) {
          UIColor(hue: CGFloat(x) / 600, saturation: 0.8, brightness: 0.9, alpha: 1).setFill()
          context.fill(CGRect(x: CGFloat(x), y: 0, width: 3, height: 400))
        }
      }
      let limit = 20_000
      #expect(large.count > limit)
      let prepared = try #require(await ComposerImage.prepare(large, limit: limit))
      #expect(prepared.type == .jpeg && prepared.data.count <= limit)
      #expect(imageType(of: prepared.data) == .jpeg)
      let picture = try #require(UIImage(data: prepared.data))
      #expect(picture.size.width / picture.size.height == 1.5)
    }
  #endif
}
