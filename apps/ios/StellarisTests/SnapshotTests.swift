import BoardKit
import SwiftUI
import XCTest

@testable import Stellaris

/// The shell's views at every width and type size, over the fake board's answers. The pictures go
/// with the test's results for review; these tests fail only when a view can't be drawn.
final class SnapshotTests: XCTestCase {
  /// A list drawn by the system, with a row in a colour nothing else uses, shows that row.
  @MainActor func testCapturesASystemList() async throws {
    let marker = (red: 255, green: 0, blue: 255)
    let list = List {
      Text("A row the picture must hold")
        .listRowBackground(Color(red: 1, green: 0, blue: 1))
    }
    let image = try await Snapshot.image(
      of: list, size: CGSize(width: 410, height: 678), type: Snapshot.typeSizes[0])
    try Snapshot.keep(image, named: "proof-system-list", in: self)
    XCTAssertGreaterThan(Snapshot.pixels(in: image, near: marker), 410 * 20)
    let empty = try await Snapshot.image(
      of: List {}, size: CGSize(width: 410, height: 678), type: Snapshot.typeSizes[0])
    XCTAssertEqual(Snapshot.pixels(in: empty, near: marker), 0)
  }

  @MainActor func testSignIn() async throws {
    let (model, _) = fakeApp()
    await model.start()
    try await Snapshot.record(SignInView().environment(model), named: "sign-in", in: self)
    let config = AuthConfig(github: true, appLanding: true)
    try await Snapshot.record(
      SignInView(checked: (FakeBoard.address, config)).environment(model),
      named: "sign-in-options", in: self)
  }

  @MainActor func testChat() async throws {
    let model = try await signedIn()
    await model.feed(for: .general).load(using: model)
    try await Snapshot.record(ShellView().environment(model), named: "chat", in: self)
    let thread = Conversation.thread("00000000000000000000000010")
    model.open(thread)
    await model.feed(for: thread).load(using: model)
    try await Snapshot.record(ShellView().environment(model), named: "chat-thread", in: self)
  }

  @MainActor func testBoard() async throws {
    let model = try await signedIn()
    model.tab = .board
    try await Snapshot.record(ShellView().environment(model), named: "board", in: self)
  }

  @MainActor func testNeedsYou() async throws {
    let model = try await signedIn()
    model.tab = .needsYou
    try await Snapshot.record(ShellView().environment(model), named: "needs-you", in: self)
  }

  /// Board and Needs you once a refresh after the board loaded has failed.
  @MainActor func testBoardAfterARefreshFails() async throws {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: "fading")
    try await waitUntilLoaded(model)
    await model.refresh()
    XCTAssertEqual(model.store.state, .failed(Loading.unreachable))
    XCTAssertFalse(model.store.attention.isEmpty)
    model.tab = .board
    try await Snapshot.record(
      ShellView().environment(model), named: "board-refresh-failed", in: self)
    model.tab = .needsYou
    try await Snapshot.record(
      ShellView().environment(model), named: "needs-you-refresh-failed", in: self)
  }

  @MainActor func testSettings() async throws {
    let model = try await signedIn()
    try await Snapshot.record(SettingsView().environment(model), named: "settings", in: self)
  }

  /// Each of the samples, the thread general's newest message links to, alone at every size, on
  /// the conversation's gray, from its top.
  @MainActor func testMessages() async throws {
    let model = try await signedIn()
    let samples = Conversation.thread(FakeBoard.samples)
    await model.feed(for: samples).load(using: model)
    let messages = model.feed(for: samples).messages
    XCTAssertEqual(messages.count, 6)
    for (index, message) in messages.enumerated() {
      let row = MessageRow(message: message)
        .environment(model)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(red: 20 / 255, green: 20 / 255, blue: 20 / 255))
      try await Snapshot.record(row, named: "message-\(index + 1)", in: self)
    }
    model.open(samples)
    try await Snapshot.record(ShellView().environment(model), named: "chat-samples", in: self)
  }

  /// The conversation sits on the web's island, `surface-1` at 80% over `surface-0`, which the
  /// browser blends to 20 in each channel, not on black.
  @MainActor func testTheConversationIsTheWebsGray() async throws {
    let model = try await signedIn()
    await model.feed(for: .general).load(using: model)
    let image = try await Snapshot.image(
      of: ShellView().environment(model), size: CGSize(width: 410, height: 678),
      type: Snapshot.typeSizes[0])
    try Snapshot.keep(image, named: "proof-conversation-gray", in: self)
    let picture = try XCTUnwrap(image.cgImage)
    let pixels = picture.width * picture.height
    let gray = Snapshot.pixels(in: image, near: (red: 20, green: 20, blue: 20), within: 4)
    XCTAssertGreaterThan(gray, pixels / 3, "the conversation isn't on the island's gray")
  }

  @MainActor private func signedIn() async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: "fixture-token")
    await model.refresh()
    return model
  }
}
