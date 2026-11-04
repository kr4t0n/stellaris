import BoardKit
import Foundation
import Testing

#if canImport(UIKit)
  import UIKit
#endif

@testable import Stellaris

/// Images put in a draft over the fake board: each holds its place where the caret was, on a line
/// of its own, until the board's markdown for it takes that place, in whatever order the uploads
/// end; bytes that hold no picture leave a reason and no line, which the next post clears; and Send
/// waits while one is on its way. Each test signs in with a token of its own, which the fake board
/// keeps its writes under.
@MainActor @Suite(.serialized) struct ComposerImageTests {
  private let general = Conversation.general
  /// A PNG of one pixel, whole, since the app sends no image that doesn't read to its end.
  private let png = Data(
    base64Encoded: [
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUzZswgIiSpAAAACklEQVQI12NgAAAAAgAB",
      "4iG8MwAAAABJRU5ErkJggg==",
    ].joined())!

  private func signedIn() async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: "upload-\(UUID().uuidString)")
    try await waitUntilLoaded(model)
    return model
  }

  /// Signed in with the uploads held until the test settles them.
  private func signedIn(holding gate: HeldBoard.Gate) async throws -> AppModel {
    let (model, _) = fakeApp(holding: gate)
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: gate.token)
    try await waitUntilLoaded(model)
    return model
  }

  @Test func anImageTakesThePlaceItHeldAtTheCaret() async throws {
    let model = try await signedIn()
    model.memory?.setDraft("Before  after", for: general)
    let held = model.holdImages(1, in: general, start: 7, end: 7)
    let line = try #require(held.placeholders.first)
    #expect(held.placeholders == ["![Uploading image…]()"])
    #expect(held.caret == 7 + line.utf16.count)
    #expect(model.memory?.draft(general) == "Before ![Uploading image…]() after")
    #expect(model.uploading[general.key] == 1)

    // The caret, just after the line, goes after the markdown that takes its place.
    let settled = try #require(
      await model.upload(png, holding: line, in: general) { held.caret })
    let draft = try #require(model.memory?.draft(general))
    #expect(
      draft.wholeMatch(of: /Before !\[image\.png\]\(image:00000000000000000000PHT001\) after/)
        != nil, "\(draft)")
    #expect(settled.text == draft)
    #expect(settled.caret == draft.utf16.count - " after".utf16.count)
    #expect(model.uploading[general.key] == nil)
    #expect(model.uploadFailures[general.key] == nil)
  }

  @Test func whatHoldsNoPictureLeavesAReasonAndNoLine() async throws {
    let model = try await signedIn()
    model.memory?.setDraft("See: ", for: general)
    let held = model.holdImages(2, in: general, start: 5, end: 5)
    #expect(held.placeholders == ["![Uploading image…]()", "![Uploading image (2)…]()"])
    #expect(model.memory?.draft(general) == "See: \(held.placeholders.joined(separator: "\n"))")

    await model.upload(Data("<svg/>".utf8), holding: held.placeholders[0], in: general)
    #expect(model.uploadFailures[general.key] == "The image could not be read.")
    #expect(model.memory?.draft(general) == "See: \n\(held.placeholders[1])")
    #expect(model.uploading[general.key] == 1)
    // Photos or the pasteboard gave nothing at all.
    await model.upload(nil, holding: held.placeholders[1], in: general)
    #expect(model.memory?.draft(general) == "See: \n")
    #expect(model.uploading[general.key] == nil)

    // The next image clears the reason, and so does a post.
    let next = model.holdImages(1, in: general, start: 0, end: 0)
    #expect(model.uploadFailures[general.key] == nil)
    await model.upload(nil, holding: next.placeholders[0], in: general)
    #expect(model.uploadFailures[general.key] != nil)
    _ = try await model.post("Without it.", to: general)
    #expect(model.uploadFailures[general.key] == nil)
  }

  @Test func aLineTheUserDeletedTakesNoImage() async throws {
    let model = try await signedIn()
    let held = model.holdImages(1, in: general, start: 0, end: 0)
    model.memory?.setDraft("Changed my mind.", for: general)
    await model.upload(png, holding: held.placeholders[0], in: general)
    #expect(model.memory?.draft(general) == "Changed my mind.")
    #expect(model.uploading[general.key] == nil)
  }

  /// Photos picked together, or pasted one after another, whose uploads end in the other order,
  /// each land where they were put: every image has the same name, so the lines differ by number.
  @Test func imagesLandWhereTheyWerePutWhicheverEndsFirst() async throws {
    let model = try await signedIn()
    model.memory?.setDraft("A: ", for: general)
    let first = model.holdImages(1, in: general, start: 3, end: 3)
    let draft = model.memory?.draft(general) ?? ""
    model.memory?.setDraft(draft + " B: ", for: general)
    let end = draft.utf16.count + " B: ".utf16.count
    let second = model.holdImages(1, in: general, start: end, end: end)
    #expect(first.placeholders == ["![Uploading image…]()"])
    #expect(second.placeholders == ["![Uploading image (2)…]()"])

    // The second ends first and takes the board's first id, into its own line.
    await model.upload(png, holding: second.placeholders[0], in: general)
    await model.upload(png, holding: first.placeholders[0], in: general)
    let kept = (first: "00000000000000000000PHT002", second: "00000000000000000000PHT001")
    #expect(
      model.memory?.draft(general)
        == "A: ![image.png](image:\(kept.first)) B: ![image.png](image:\(kept.second))")

    // A line an upload still holds, though the user deleted it, is not given to the next image.
    let third = model.holdImages(1, in: general, start: 0, end: 0)
    model.memory?.setDraft("", for: general)
    let fourth = model.holdImages(1, in: general, start: 0, end: 0)
    #expect(third.placeholders == ["![Uploading image…]()"])
    #expect(fourth.placeholders == ["![Uploading image (2)…]()"])
    await model.upload(png, holding: third.placeholders[0], in: general)
    #expect(model.memory?.draft(general) == fourth.placeholders[0])
  }

  /// The images the draft holds, for its thumbnails: an upload's line while it is on its way, then
  /// the board's copy by its id, which the × takes out with its markdown.
  @Test(.timeLimit(.minutes(1))) func theDraftsImagesAreItsUploadsThenWhatTheBoardKept()
    async throws
  {
    let gate = HeldBoard.Gate(paths: ["/api/images"])
    let model = try await signedIn(holding: gate)
    #if canImport(UIKit)
      // A picture ImageIO can read, for the upload's own thumbnail.
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let bytes = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 200), format: format)
        .pngData { context in
          UIColor.systemTeal.setFill()
          context.fill(CGRect(x: 0, y: 0, width: 300, height: 200))
        }
    #else
      let bytes = png
    #endif
    model.memory?.setDraft("See ", for: general)
    let held = model.holdImages(1, in: general, start: 4, end: 4)
    let line = held.placeholders[0]
    let uploading = Task { await model.upload(bytes, holding: line, in: general) }
    await gate.arrivals(1)
    #expect(
      model.draftImages(in: general)
        == [DraftImage(kind: .uploading, start: 4, text: line, id: nil, alt: "image")])
    #if canImport(UIKit)
      let preview = try #require(model.uploadPreviews[general.key]?[line])
      let picture = try #require(UIImage(data: preview))
      #expect(max(picture.size.width, picture.size.height) <= 192)
    #endif
    // As the board answered the upload that went, which the fake board kept as it arrived.
    gate.answerAsArrived()
    _ = await uploading.value
    #expect(model.uploadPreviews[general.key]?[line] == nil)
    let kept = try #require(model.draftImages(in: general).first)
    #expect(kept.kind == .kept && kept.id != nil && kept.alt == "image.png" && kept.start == 4)

    let removed = model.removeImage(kept, from: general, caret: 4 + kept.text.utf16.count)
    #expect(removed == DraftEdit(text: "See ", caret: 4))
    #expect(model.memory?.draft(general) == "See ")
    #expect(model.draftImages(in: general).isEmpty)
  }

  /// A draft saved while an image uploaded, as when the app ended then, loads without the line:
  /// no upload survives to fill it, and its thumbnail would say "Uploading…" for good.
  @Test func aSavedDraftLoadsWithoutTheLinesNoUploadHolds() {
    let defaults = UserDefaults(suiteName: "drafts-\(UUID().uuidString)")!
    let board = FakeBoard.address
    let first = ConversationMemory(board: board, defaults: defaults)
    first.setDraft("Before ![Uploading image…]() after", for: general)
    first.setDraft("![Uploading image…]()", for: .channel("lab/general"))
    let next = ConversationMemory(board: board, defaults: defaults)
    #expect(next.draft(general) == "Before  after")
    #expect(next.draft(.channel("lab/general")) == "")
  }

  /// How an image with metadata goes is in `PhotoMetadataTests`.
  @Test func keepsWhatTheBoardTakesAsItIs() async throws {
    #expect(await ComposerImage.prepare(png) == ComposerImage(data: png, type: .png))
    #expect(await ComposerImage.prepare(png)?.name == "image.png")
    #expect(await ComposerImage.prepare(Data("<svg/>".utf8)) == nil)
    // A WebP's header alone, its RIFF shorter than the header itself, holds no picture.
    let header = Data(Array("RIFF".utf8) + [3, 0, 0, 0] + Array("WEBP".utf8))
    #expect(await ComposerImage.prepare(header) == nil)
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
      // Past the limit without what UIKit writes beside the picture too, which the app leaves out.
      let limit = try #require(withoutMetadata(large)).count / 2
      #expect(large.count > limit)
      let prepared = try #require(await ComposerImage.prepare(large, limit: limit))
      #expect(prepared.type == .jpeg && prepared.data.count <= limit)
      #expect(imageType(of: prepared.data) == .jpeg)
      // Upright and of the same shape, to the pixel it was rounded to.
      let picture = try #require(UIImage(data: prepared.data))
      #expect(abs(picture.size.width / picture.size.height - 1.5) < 0.01)
    }
  #endif
}
