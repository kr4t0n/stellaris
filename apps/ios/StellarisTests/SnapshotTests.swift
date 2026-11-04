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
  /// the conversation's gray, whole.
  @MainActor func testMessages() async throws {
    let model = try await signedIn()
    let samples = Conversation.thread(FakeBoard.samples)
    await model.feed(for: samples).load(using: model)
    let messages = model.feed(for: samples).messages
    XCTAssertEqual(messages.count, 6)
    for (index, message) in messages.enumerated() {
      let row = MessageRow(message: message)
        .environment(model)
        .background(Color(red: 20 / 255, green: 20 / 255, blue: 20 / 255))
      try await Snapshot.recordWhole(row, named: "message-\(index + 1)", in: self)
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

  /// The draft at rest is Safari's capsule: 48 points tall at one line, its ends round all the way,
  /// on the conversation's gray with no strip or hairline above it, and no Send while its field
  /// isn't focused, though it holds text.
  @MainActor func testTheDraftAtRestIsACapsuleWithNoSend() async throws {
    let model = try await signedIn()
    model.memory?.setDraft("Ship it", for: .general)
    let image = try await Snapshot.image(
      of: DraftField(conversation: .general).background(MessageColor.island).environment(model),
      size: CGSize(width: 410, height: 100), type: Snapshot.typeSizes[0], fitting: true)
    try Snapshot.keep(image, named: "proof-draft-capsule", in: self)
    let bitmap = try XCTUnwrap(Snapshot.Bitmap(image))
    let width = CGFloat(bitmap.width) / bitmap.scale
    let height = CGFloat(bitmap.height) / bitmap.scale
    // Lighter than the island's 20 in each channel; a shadow, darker, is no part of the box.
    func drawn(_ x: CGFloat, _ y: CGFloat) -> Bool {
      let pixel = bitmap.pixel(at: CGPoint(x: x, y: y))
      return pixel.red + pixel.green + pixel.blue > 3 * 26
    }
    XCTAssertFalse(drawn(width / 2, 0.5), "a hairline runs above the draft")
    // The longest run of drawn points down a line a third of the way across, past the text.
    let across = width / 3
    var run = (start: 0, length: 0)
    var current = (start: 0, length: 0)
    for y in 0..<Int(height) {
      if drawn(across, CGFloat(y) + 0.5) {
        current = (current.length == 0 ? y : current.start, current.length + 1)
        if current.length > run.length {
          run = current
        }
      } else {
        current = (0, 0)
      }
    }
    XCTAssertEqual(run.length, 48, accuracy: 2, "the draft at rest isn't Safari's 48 points tall")
    let top = CGFloat(run.start)
    let middle = top + CGFloat(run.length) / 2
    let leading = try XCTUnwrap(
      (0..<Int(across)).first { drawn(CGFloat($0) + 0.5, middle) }, "the draft draws no box")
    // Half its height round: a point 4 in from the corner of its frame is outside a capsule, and
    // inside a box rounded less.
    XCTAssertFalse(
      drawn(CGFloat(leading) + 4, top + 4), "the draft's ends aren't round all the way")
    XCTAssertTrue(drawn(CGFloat(leading) + 4, middle), "the draft's end isn't drawn")
    // Send would be the web's primary white, at the trailing end, with text to send.
    let primary = (red: 245, green: 245, blue: 245)
    var white = 0
    for y in stride(from: top, to: top + CGFloat(run.length), by: 1 / bitmap.scale) {
      for x in stride(from: width * 2 / 3, to: width, by: 1 / bitmap.scale) {
        if bitmap.pixel(at: CGPoint(x: x, y: y), isNear: primary, within: 12) {
          white += 1
        }
      }
    }
    XCTAssertLessThan(white, 2_500, "the draft at rest draws a Send")
  }

  /// A thread opened from #general, with its first message and its draft, then #general with
  /// the thread at its foot, where it was opened.
  @MainActor func testAThreadOpenedOnAChannel() async throws {
    let model = try await signedIn(token: "snapshot-\(UUID().uuidString)")
    model.newThreads["general"] = NewThreadDraft(
      title: "Release checklist for the export view, the empty state, and the narrow widths",
      body: "Docs first, then the release notes. @eng-1, the empty state is yours.")
    try await model.openThread(in: "general")
    await model.feed(for: model.history.current).load(using: model)
    try await Snapshot.record(ShellView().environment(model), named: "chat-new-thread", in: self)
    model.goBack()
    await model.feed(for: .general).load(using: model)
    try await Snapshot.record(
      ShellView().environment(model), named: "chat-channel-thread", in: self)
  }

  /// The New thread sheet, with what it says so far.
  @MainActor func testNewThreadSheet() async throws {
    let model = try await signedIn()
    model.newThreads["general"] = NewThreadDraft(
      title: "Release checklist", body: "Docs first, then the release notes.")
    try await Snapshot.record(
      NewThreadSheet(channel: "general").environment(model), named: "new-thread", in: self)
  }

  /// The draft at its tallest, five lines and then scrolling, or two where the window is short,
  /// as the outer display is in landscape, alone and in Chat, where at rest it reaches down to the
  /// side bar's foot; and the citizens a mention offers.
  @MainActor func testTheComposer() async throws {
    let model = try await signedIn()
    model.memory?.setDraft(
      (1...7).map { "Line \($0) of a long draft, which scrolls past the fifth." }
        .joined(separator: "\n"), for: .general)
    // In whole windows, at their foot: a window cut to the draft's own height would be short, and
    // its size class would hold the draft to two lines.
    let draft = VStack(spacing: 0) {
      Spacer(minLength: 0)
      DraftField(conversation: .general)
    }
    .background(MessageColor.island)
    .environment(model)
    try await Snapshot.record(draft, named: "composer-long", in: self)
    for type in Snapshot.typeSizes {
      print("drawing composer-short-window-\(type.name)")
      let image = try await Snapshot.image(
        of: draft.environment(\.verticalSizeClass, .compact),
        size: CGSize(width: 678, height: 466), type: type)
      try Snapshot.keep(image, named: "composer-short-window-\(type.name)", in: self)
    }
    await model.feed(for: .general).load(using: model)
    try await Snapshot.record(
      ShellView().environment(model), named: "composer-long-in-chat", in: self)
    let list = MentionList(members: model.store.mentionable("")) { _ in }
      .padding(12).background(MessageColor.island)
    try await Snapshot.recordWhole(list, named: "mention-list", in: self)
  }

  /// The message a link named, marked as the web marks it; a closed thread's end; and a channel
  /// that takes no posts.
  @MainActor func testMarksAndEnds() async throws {
    let model = try await signedIn()
    await model.feed(for: .general).load(using: model)
    let note = try XCTUnwrap(
      model.feed(for: .general).messages.first { $0.id == FakeBoard.generalId(30) })
    try await Snapshot.recordWhole(
      MessageRow(message: note, marked: true).environment(model).background(MessageColor.island),
      named: "message-marked", in: self)
    let closed = try JSONDecoder().decode(
      BoardThread.self,
      from: Data(
        #"""
        {"id":"00000000000000000000000002","channel":"general","title":"Release notes",
        "state":"closed","openedBy":"concierge-1","openedAt":"2026-01-01T09:00:00.000Z",
        "closedBy":"eng-1","closedAt":"2026-01-01T10:00:00.000Z",
        "body":"Shipped with **the export view** and its empty state."}
        """#.utf8))
    try await Snapshot.recordWhole(
      ClosedThread(thread: closed).environment(model).background(MessageColor.island),
      named: "thread-closed", in: self)
    let archived = try JSONDecoder().decode(
      ArchivedChannel.self,
      from: Data(
        #"{"name":"export","at":"2026-01-01T10:00:00.000Z","by":"user","reason":"done"}"#.utf8))
    try await Snapshot.recordWhole(
      ReadOnlyLine(readOnly: .archived(archived)).background(MessageColor.island),
      named: "channel-read-only", in: self)
  }

  /// A task's thread with its strip and a step's chip, at a gate that waits on the user, and a
  /// proposal's thread waiting on the user, in Chat.
  @MainActor func testATasksAndAProposalsThread() async throws {
    let model = try await signedIn()
    for (name, id) in [("chat-task", exportView), ("chat-proposal", memberProposal)] {
      model.open(.thread(id))
      await model.feed(for: .thread(id)).load(using: model)
      try await Snapshot.record(ShellView().environment(model), named: name, in: self)
    }
  }

  /// The plan and the charter opened from the bar: beside the thread from 640 points wide, and in
  /// a sheet at the narrower widths, a column of the inner display folded like a book among them.
  @MainActor func testThePlanAndTheCharterBesideTheThreadOrInASheet() async throws {
    let model = try await signedIn()
    for (name, id) in [("chat-plan", exportView), ("chat-charter", memberProposal)] {
      model.open(.thread(id))
      await model.feed(for: .thread(id)).load(using: model)
      model.inspecting = id
      try await Snapshot.record(ShellView().environment(model), named: name, in: self)
    }
  }

  /// A task's plan whole, and each captured proposal's charter.
  @MainActor func testPlansAndCharters() async throws {
    let model = try await signedIn()
    let task = try XCTUnwrap(model.store.task(exportView))
    try await Snapshot.recordWhole(
      PlanView(task: task).environment(model), named: "plan", in: self)
    for proposal in model.store.proposals {
      try await Snapshot.recordWhole(
        CharterView(proposal: proposal).environment(model),
        named: "charter-\(proposal.kind.rawValue)", in: self)
    }
  }

  /// The Advance and Reject sheets, with what they say so far.
  @MainActor func testTheAdvanceAndRejectSheets() async throws {
    let model = try await signedIn()
    model.advanceNotes[exportView] =
      "The design is approved; the empty state follows in its own task."
    try await Snapshot.record(
      AdvanceSheet(taskId: exportView).environment(model), named: "advance", in: self)
    let reject = Verdict(proposal: "00000000000000000000000008", choice: .reject)
    model.reasons[reject] = "One reviewer keeps up for now."
    try await Snapshot.record(
      DecisionSheet(verdict: reject).environment(model), named: "reject", in: self)
  }

  /// A project's dashboard and its tasks by where they stand, under Board.
  @MainActor func testAProject() async throws {
    let model = try await signedIn()
    await model.store.loadDashboard("demo", using: model)
    model.tab = .board
    model.boardPath = ["demo"]
    try await Snapshot.record(ShellView().environment(model), named: "board-project", in: self)
  }

  /// A task at a gate that waits on the user, and a member proposal that waits on the user.
  private let exportView = "00000000000000000000000010"
  private let memberProposal = "00000000000000000000000004"

  @MainActor private func signedIn(token: String = "fixture-token") async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: token)
    await model.refresh()
    return model
  }
}
