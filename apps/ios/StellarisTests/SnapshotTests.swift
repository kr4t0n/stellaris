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
    // The round Send stands beside the capsule, which would then end 58 points short of the
    // draft's trailing edge, 12 in.
    XCTAssertTrue(drawn(width - 16, middle), "the capsule ends short of the draft's edge")
    // The web's Send was a white button at the trailing end, with text to send.
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

  /// Board, a project under it, Needs you, and Settings sit on the conversation's island gray, as
  /// the chat beside them does, with their rows on `surface-2` at 50% over it, which blends to 29
  /// in each channel, and nothing black.
  @MainActor func testTheListsAreTheChatsGray() async throws {
    let model = try await signedIn()
    await model.store.loadDashboard("demo", using: model)
    model.tab = .board
    try await expectIslandGray(ShellView().environment(model), named: "board")
    model.boardPath = [.project("demo")]
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
  /// header pins at the top with rows going under it. iOS draws its hard scroll edge effect from
  /// the bar to the pinned header's foot, the island blurred: the band holds no black, its
  /// commonest colour is a neutral gray no darker than the island, and the island resumes below.
  @MainActor func testAPinnedHeaderSitsOnTheIslandUnderTheEdgeEffect() async throws {
    let model = try await signedIn()
    await model.store.loadDashboard("demo", using: model)
    model.tab = .board
    model.boardPath = [.project("demo")]
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
    let (red, green, blue) = ground.color
    XCTAssertTrue(
      abs(red - green) <= 2 && abs(green - blue) <= 2 && (20...40).contains(green),
      "the pinned header's band has a ground of its own: \(shown)")
    XCTAssertLessThan(black, 0.01, "the pinned header's band draws black: \(shown)")
    let below = Snapshot.colors(
      in: image, within: CGRect(x: band.minX, y: band.maxY + 1, width: band.width, height: 10))
    let island = below.filter {
      [$0.color.red, $0.color.green, $0.color.blue].allSatisfy { abs($0 - 20) <= 2 }
    }.reduce(0) { $0 + $1.share }
    XCTAssertGreaterThan(
      island, 0.5, "the island doesn't resume below the pinned header: \(below.prefix(5))")
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

  /// A task's plan whole, ending with what its branch changed, and each captured proposal's
  /// charter. At 320 points the plan is as wide as its column beside the thread. At the largest
  /// type size the plan with six changes runs past what the harness can draw at the narrower
  /// widths, so there it is drawn before a turn made the task's branch, and `testATasksChanges`
  /// draws the changes alone.
  @MainActor func testPlansAndCharters() async throws {
    let model = try await signedIn()
    let task = try XCTUnwrap(model.store.task(exportView))
    await model.store.loadTaskChanges(exportView, using: model)
    let branchless = try await signedIn(token: "no-branch")
    await branchless.store.loadTaskChanges(exportView, using: branchless)
    for size in Snapshot.sizes {
      for type in Snapshot.typeSizes {
        let name = "plan-\(size.name)-\(type.name)"
        print("drawing \(name)")
        let shown = type.name == "largest" ? branchless : model
        let image = try await Snapshot.image(
          of: PlanView(task: task).environment(shown), size: size.size, type: type, fitting: true)
        try Snapshot.keep(image, named: name, in: self)
      }
    }
    for proposal in model.store.proposals {
      try await Snapshot.recordWhole(
        CharterView(proposal: proposal).environment(model),
        named: "charter-\(proposal.kind.rawValue)", in: self)
    }
  }

  /// The plan's Files alone, and a file's change on the plan's stack, with Whole file in its bar,
  /// at every width and type size;
  /// then, on the outer display, a binary file's, one whose lines didn't change, one the board cut,
  /// a deleted file's, which has no Whole file, and one the runner can't read; and the plan's
  /// Files with the runner away, before the task's branch, with nothing changed, and past the
  /// board's limit.
  @MainActor func testATasksChanges() async throws {
    let model = try await signedIn()
    await model.store.loadTaskChanges(exportView, using: model)
    let task = exportView
    func change(_ path: String, in model: AppModel) async -> AnyView {
      await model.store.loadTaskDiff(ChangeKey(task: task, path: path), using: model)
      return AnyView(
        NavigationStack {
          ChangeView(taskId: task, path: path) { _ in }
        }
        .environment(model))
    }
    // The plan's Files alone, at every width and type size.
    let subject = try XCTUnwrap(model.store.task(exportView))
    try await Snapshot.recordWhole(
      TaskFiles(task: subject, now: .now)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(MessageColor.island)
        .environment(model),
      named: "plan-files", in: self)
    try await Snapshot.record(
      await change("src/export/view.ts", in: model), named: "change-code", in: self)
    for (name, path) in [
      ("change-binary", "evidence/plot.png"), ("change-no-lines", "scripts/run.sh"),
      ("change-cut", "data/export.json"), ("change-deleted", "src/export/old.ts"),
      ("change-notes", "evidence/notes.md"),
    ] {
      try await keepAtTheOuterDisplay(await change(path, in: model), named: name)
    }
    // The deleted file's removed lines read as one band down the patch's leading edge, a point
    // in from it, with no notch where one line's ground meets the next's: a colour alone as each
    // line's background drew it with rounded corners.
    let deleted = try await Snapshot.image(
      of: await change("src/export/old.ts", in: model), size: CGSize(width: 410, height: 678),
      type: Snapshot.typeSizes[0])
    var bands = 0
    var inBand = false
    for y in stride(from: 100.0, to: 600.0, by: 0.5) {
      let red = Snapshot.color(in: deleted, at: CGPoint(x: 17, y: y)).map {
        $0.red > $0.green + 8
      }
      if red == true, !inBand {
        bands += 1
      }
      inBand = red == true
    }
    XCTAssertEqual(bands, 1, "the removed lines' ground breaks into \(bands) bands")
    let away = try await signedIn(token: "runner-away")
    try await keepAtTheOuterDisplay(
      await change("src/export/view.ts", in: away), named: "change-runner-away")
    for token in ["runner-away", "no-branch", "nothing-changed", "many-changes"] {
      let other = try await signedIn(token: token)
      await other.store.loadTaskChanges(exportView, using: other)
      let task = try XCTUnwrap(other.store.task(exportView))
      let files = TaskFiles(task: task, now: .now)
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(MessageColor.island)
      try await keepAtTheOuterDisplay(files.environment(other), named: "plan-files-\(token)")
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
    model.boardPath = [.project("demo")]
    try await Snapshot.record(ShellView().environment(model), named: "board-project", in: self)
  }

  /// A project's files under Board: Board with its Files row, the branch's root, markdown, and
  /// code at a cited line at every width and type size; a table, an image, a binary file, one over
  /// the board's limit, a path the branch doesn't have, the runner away, and an empty branch at
  /// the outer display's; and a file a message linked, in Chat's sheet.
  @MainActor func testTheFiles() async throws {
    let model = try await signedIn()
    model.tab = .board
    try await Snapshot.record(ShellView().environment(model), named: "board-files-row", in: self)
    func place(_ path: String, line: Int? = nil) -> FilePlace {
      FilePlace(source: .project("demo"), path: path, line: line)
    }
    for (name, file) in [
      ("files-root", place("")), ("files-markdown", place("README.md")),
      ("files-code", place("src/app.ts", line: 30)),
    ] {
      await model.store.loadBranchFile(file, using: model)
      model.boardPath = [.files(file)]
      try await Snapshot.record(ShellView().environment(model), named: name, in: self)
    }
    for (name, file) in [
      ("files-table", place("results.csv")), ("files-image", place("plot.png")),
      ("files-binary", place("model.bin")), ("files-too-large", place("dump.json")),
      ("files-missing", place("notes/plan.md")),
    ] {
      await model.store.loadBranchFile(file, using: model)
      model.boardPath = [.files(file)]
      try await keepAtTheOuterDisplay(ShellView().environment(model), named: name)
    }
    for token in ["runner-away", "empty-branch"] {
      let other = try await signedIn(token: token)
      await other.store.loadBranchFile(place(""), using: other)
      other.tab = .board
      other.boardPath = [.files(place(""))]
      try await keepAtTheOuterDisplay(ShellView().environment(other), named: "files-\(token)")
    }
    let notes = FilePlace(source: .task(exportView), path: "evidence/notes.md")
    await model.store.loadBranchFile(notes, using: model)
    model.browse(notes)
    try await keepAtTheOuterDisplay(FileSheet().environment(model), named: "files-sheet")
  }

  /// Draws `view` once, at the outer display's width and the default type size.
  @MainActor private func keepAtTheOuterDisplay(_ view: some View, named name: String) async throws
  {
    let image = try await Snapshot.image(
      of: view, size: CGSize(width: 410, height: 678), type: Snapshot.typeSizes[0])
    try Snapshot.keep(image, named: "\(name)-410-default", in: self)
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
