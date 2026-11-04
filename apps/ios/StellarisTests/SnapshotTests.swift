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

  /// The draft is the web's composer: a box of `surface-2` at 50% over the island's gray, which
  /// blends to 29 in each channel, with nothing black in its row.
  @MainActor func testTheDraftIsTheWebsComposer() async throws {
    let model = try await signedIn()
    let image = try await Snapshot.image(
      of: DraftField(conversation: .general).background(MessageColor.island).environment(model),
      size: CGSize(width: 410, height: 100), type: Snapshot.typeSizes[0], fitting: true)
    try Snapshot.keep(image, named: "proof-draft-composer", in: self)
    let picture = try XCTUnwrap(image.cgImage)
    let pixels = picture.width * picture.height
    let box = Snapshot.pixels(in: image, near: (red: 29, green: 29, blue: 29), within: 3)
    let black = Snapshot.pixels(in: image, near: (red: 0, green: 0, blue: 0), within: 6)
    XCTAssertGreaterThan(box, pixels / 3, "the draft's box isn't the composer's gray")
    XCTAssertLessThan(black, pixels / 100, "the draft's row draws black")
  }

  /// Board, a project under it, Needs you, and Settings sit on the conversation's island gray, as
  /// the chat beside them does, with their rows on `surface-2` at 50% over it, which blends to 29
  /// in each channel, and nothing black.
  @MainActor func testTheListsAreTheChatsGray() async throws {
    let model = try await signedIn()
    await model.store.loadDashboard("demo", using: model)
    model.tab = .board
    try await expectIslandGray(ShellView().environment(model), named: "board")
    model.boardPath = ["demo"]
    try await expectIslandGray(ShellView().environment(model), named: "board-project")
    model.tab = .needsYou
    try await expectIslandGray(ShellView().environment(model), named: "needs-you")
    try await expectIslandGray(SettingsView().environment(model), named: "settings")
  }

  /// Checks `view` is on the island's gray with its rows on the row's, and draws no black.
  @MainActor private func expectIslandGray(_ view: some View, named name: String) async throws {
    let image = try await Snapshot.image(
      of: view, size: CGSize(width: 410, height: 678), type: Snapshot.typeSizes[0])
    try Snapshot.keep(image, named: "proof-\(name)-gray", in: self)
    let picture = try XCTUnwrap(image.cgImage)
    let pixels = picture.width * picture.height
    let gray = Snapshot.pixels(in: image, near: (red: 20, green: 20, blue: 20), within: 4)
    let rows = Snapshot.pixels(in: image, near: (red: 29, green: 29, blue: 29), within: 2)
    let black = Snapshot.pixels(in: image, near: (red: 0, green: 0, blue: 0), within: 6)
    XCTAssertGreaterThan(gray, pixels / 4, "\(name) isn't on the island's gray")
    XCTAssertGreaterThan(rows, pixels / 20, "\(name)'s rows aren't on the row's gray")
    XCTAssertLessThan(black, pixels / 100, "\(name) draws black")
  }

  /// A row of Board drawn pressed, and one drawn selected, as a touch and an opened row leave their
  /// list's cells, stand apart from the rows at rest, as the system's own rows do.
  @MainActor func testBoardsRowsShowWhenPressedAndSelected() async throws {
    let model = try await signedIn()
    let size = CGSize(width: 410, height: 678)
    var spots: [CGPoint] = []
    let rest = try await Snapshot.image(
      of: BoardView().environment(model), size: size, type: Snapshot.typeSizes[0]
    ) { view in
      spots = try self.firstRows(in: view).map { $0.spot }
    }
    let marked = try await Snapshot.image(
      of: BoardView().environment(model), size: size, type: Snapshot.typeSizes[0]
    ) { view in
      let rows = try self.firstRows(in: view)
      rows[0].cell.isHighlighted = true
      rows[1].cell.isSelected = true
    }
    try Snapshot.keep(rest, named: "proof-rows-at-rest", in: self)
    try Snapshot.keep(marked, named: "proof-rows-pressed-and-selected", in: self)
    XCTAssertEqual(spots.count, 2)
    for (spot, state) in zip(spots, ["pressed", "selected"]) {
      let before = try XCTUnwrap(Snapshot.color(in: rest, at: spot))
      let after = try XCTUnwrap(Snapshot.color(in: marked, at: spot))
      let change = max(
        abs(after.red - before.red), abs(after.green - before.green),
        abs(after.blue - before.blue))
      XCTAssertGreaterThanOrEqual(
        change, 6, "a \(state) row draws as one at rest: \(before), then \(after)")
    }
  }

  /// A project's list at the largest type size, which is plain, scrolled so its second section's
  /// header pins at the top with rows going under it: the band the header takes has the island's
  /// gray for its ground, and no black.
  @MainActor func testAPinnedHeaderIsOnTheIslandsGray() async throws {
    let model = try await signedIn()
    await model.store.loadDashboard("demo", using: model)
    model.tab = .board
    model.boardPath = ["demo"]
    var band = CGRect.null
    let image = try await Snapshot.image(
      of: ShellView().environment(model), size: CGSize(width: 410, height: 678),
      type: Snapshot.typeSizes[1]
    ) { view in
      let list = try XCTUnwrap(
        self.collectionViews(in: view).max { $0.numberOfSections < $1.numberOfSections },
        "the view holds no list")
      let row = try XCTUnwrap(
        list.layoutAttributesForItem(at: IndexPath(item: 0, section: 1)),
        "the project's list has no second section")
      // The second section's first row, its top 40 points gone under the header.
      list.contentOffset.y = row.frame.minY + 40 - list.adjustedContentInset.top
      list.layoutIfNeeded()
      let header = try XCTUnwrap(self.pinnedHeader(in: list), "no header shows in the list")
      let top = list.contentOffset.y + list.adjustedContentInset.top
      print("pinned header: \(type(of: header)) at \(header.frame), the list's top at \(top)")
      XCTAssertLessThanOrEqual(abs(header.frame.minY - top), 2, "the header doesn't pin at the top")
      band = header.convert(header.bounds, to: nil)
    }
    try Snapshot.keep(image, named: "board-project-pinned-header-410-largest", in: self)
    let colors = Snapshot.colors(in: image, within: band)
    let ground = try XCTUnwrap(colors.first, "the pinned header's band is empty")
    func share(_ test: ((red: Int, green: Int, blue: Int)) -> Bool) -> Double {
      colors.filter { test($0.color) }.reduce(0) { $0 + $1.share }
    }
    let black = share { $0.red < 6 && $0.green < 6 && $0.blue < 6 }
    let white = share { $0.red > 240 && $0.green > 240 && $0.blue > 240 }
    let shown = colors.prefix(5).map { "\($0.color) \(Int(($0.share * 100).rounded()))%" }
    print("pinned header's band \(band): \(shown), white \(white)")
    let island = [ground.color.red, ground.color.green, ground.color.blue].allSatisfy {
      abs($0 - 20) <= 2
    }
    XCTAssertTrue(island, "the pinned header's band isn't on the island's gray: \(shown)")
    XCTAssertGreaterThan(ground.share, 0.4, "the pinned header's band has a ground: \(shown)")
    XCTAssertLessThan(black, 0.01, "the pinned header's band draws black: \(shown)")
  }

  /// The first two rows of the list in `view`, top first, each with a point on it, in the window,
  /// clear of its words.
  @MainActor private func firstRows(
    in view: UIView
  ) throws -> [(cell: UICollectionViewCell, spot: CGPoint)] {
    let list = try XCTUnwrap(collectionView(in: view), "the view holds no list")
    let cells = list.visibleCells.sorted { $0.frame.minY < $1.frame.minY }
    let first = try XCTUnwrap(cells.first, "the list shows no rows")
    let second = try XCTUnwrap(cells.dropFirst().first, "the list shows one row")
    return [first, second].map { cell in
      let frame = cell.convert(cell.bounds, to: nil)
      return (cell, CGPoint(x: frame.minX + frame.width * 0.8, y: frame.midY))
    }
  }

  @MainActor private func collectionView(in view: UIView) -> UICollectionView? {
    collectionViews(in: view).first
  }

  /// The lists in `view`, outermost and first laid out first.
  @MainActor private func collectionViews(in view: UIView) -> [UICollectionView] {
    if let list = view as? UICollectionView {
      return [list]
    }
    return view.subviews.flatMap { collectionViews(in: $0) }
  }

  /// The topmost section header the list shows below its top inset, a pinned one when one pins.
  @MainActor private func pinnedHeader(in list: UICollectionView) -> UICollectionReusableView? {
    let top = list.contentOffset.y + list.adjustedContentInset.top
    var headers = list.visibleSupplementaryViews(
      ofKind: UICollectionView.elementKindSectionHeader)
    if headers.isEmpty {
      // Any reusable view of the list's own that isn't a row, in case the headers are of a kind
      // of SwiftUI's own.
      headers = list.subviews.compactMap { $0 as? UICollectionReusableView }
        .filter { !($0 is UICollectionViewCell) }
    }
    for header in headers {
      print("a header of the list: \(type(of: header)) at \(header.frame)")
    }
    return headers.filter { !$0.isHidden && $0.frame.maxY > top + 1 }
      .min { $0.frame.minY < $1.frame.minY }
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
  /// as the outer display is in landscape; and the citizens a mention offers.
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
      let image = try await Snapshot.image(
        of: draft.environment(\.verticalSizeClass, .compact),
        size: CGSize(width: 678, height: 466), type: type)
      try Snapshot.keep(image, named: "composer-short-window-\(type.name)", in: self)
    }
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
