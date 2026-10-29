import BoardKit
import Foundation
import Testing

@testable import Stellaris

/// A task's advance and a proposal's decision over the fake board: a stage that waits on the user
/// finished with its note, none sent for a stage another citizen holds, a proposal approved, and a
/// rejection sent only with its reason; what each sheet says, kept until it is sent or cancelled;
/// and a proposal named as the web names it. Each test signs in with a token of its own, which the
/// fake board keeps its writes under.
@MainActor @Suite(.serialized) struct SubjectTests {
  /// A task at a gate that waits on the user, "Approve the design", and one eng-1 holds.
  private let exportView = "00000000000000000000000010"
  private let emptyState = "00000000000000000000000012"
  /// A member proposal, a channel proposal, and a reallocation, each waiting on the user.
  private let member = "00000000000000000000000004"
  private let channel = "00000000000000000000000006"
  private let reallocation = "00000000000000000000000008"

  private func signedIn() async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: "subject-\(UUID().uuidString)")
    try await waitUntilLoaded(model)
    return model
  }

  /// Signed in with the requests `gate` names held until the test settles them.
  private func signedIn(holding gate: HeldBoard.Gate) async throws -> AppModel {
    let (model, _) = fakeApp(holding: gate)
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: gate.token)
    try await waitUntilLoaded(model)
    return model
  }

  private struct DashboardInput: Encodable {
    let project: String
    let body: String
    let revision: Int
  }

  /// Writes the demo project's dashboard, as a citizen does while the app reads it.
  private func writeDashboard(_ body: String, _ model: AppModel) async throws {
    let request: BoardRequest<Dashboard> = try BoardAPI.verb(
      "update_dashboard", DashboardInput(project: "demo", body: body, revision: 1))
    _ = try await model.send(request)
  }

  /// Waits up to five seconds for `done`.
  private func eventually(_ done: () -> Bool) async throws -> Bool {
    for _ in 0..<100 where !done() {
      try await Task.sleep(for: .milliseconds(50))
    }
    return done()
  }

  /// Whether the user's stage of task `id` is among what waits on the user.
  private func waits(_ model: AppModel, at id: String) -> Bool {
    model.store.attention.contains { item in
      if case .stage(let task, _, _) = item { task.id == id } else { false }
    }
  }

  @Test func advancesAStageThatWaitsOnYouWithItsNote() async throws {
    let model = try await signedIn()
    let task = try #require(model.store.task(exportView))
    #expect(stageForYou(task)?.name == "Approve the design")
    #expect(waits(model, at: exportView))
    model.advancing = exportView
    model.advanceNotes[exportView] = "  The design is approved.  "
    try await model.advance(exportView)

    let advanced = try #require(model.store.task(exportView))
    #expect(advanced.stage == "s3")
    #expect(advanced.status == .known(.open))
    #expect(advanced.stages[1].completedBy == "user")
    #expect(model.advancing == nil)
    #expect(model.advanceNotes[exportView] == nil)
    let feed = model.feed(for: .thread(exportView))
    #expect(try await eventually { feed.messages.last?.body == "The design is approved." })
    guard case .task(let step)? = feed.messages.last?.step else {
      Issue.record("the note carries no step: \(String(describing: feed.messages.last))")
      return
    }
    #expect(step.action == .known(.advanced) && step.stage == "s2" && step.to == "s3")
    #expect(try await eventually { !waits(model, at: exportView) })
    // Its stage now waits on rev-1.
    await #expect(throws: SubjectRefusal.notYours) { try await model.advance(exportView) }
  }

  @Test func sendsNothingForAStageThatIsNotYours() async throws {
    let model = try await signedIn()
    let task = try #require(model.store.task(emptyState))
    #expect(task.holder == "eng-1")
    #expect(stageForYou(task) == nil)
    model.advanceNotes[emptyState] = "Done here."
    await #expect(throws: SubjectRefusal.notYours) { try await model.advance(emptyState) }
    let read = try await model.send(BoardAPI.task(emptyState))
    #expect(read.stage == "s1")
    #expect(read.status == .known(.claimed))
    #expect(read.stages[0].completedBy == nil)
    #expect(model.advanceNotes[emptyState] == "Done here.", "a refusal dropped the note")
  }

  @Test func approvesAProposalAndClosesItsThread() async throws {
    let model = try await signedIn()
    let verdict = Verdict(proposal: channel, choice: .approve)
    model.deciding = verdict
    try await model.decide(verdict)
    #expect(model.deciding == nil)
    #expect(try await eventually { model.store.proposal(channel)?.status == .known(.provisioned) })
    let proposal = try #require(model.store.proposal(channel))
    #expect(proposal.decidedBy == "user")
    #expect(proposal.reason == nil)
    #expect(!waitingOnYou(proposal))
    let feed = model.feed(for: .thread(channel))
    #expect(try await eventually { feed.thread?.state == .known(.closed) })
    guard case .proposal(let step)? = feed.messages.last?.step else {
      Issue.record("the decision carries no step: \(String(describing: feed.messages.last))")
      return
    }
    #expect(step.action == .known(.approved))
  }

  @Test func rejectsAProposalOnlyWithAReason() async throws {
    let model = try await signedIn()
    let verdict = Verdict(proposal: reallocation, choice: .reject)
    model.deciding = verdict
    model.reasons[verdict] = "   "
    await #expect(throws: SubjectRefusal.noReason) { try await model.decide(verdict) }
    #expect(model.store.proposal(reallocation)?.status == .known(.proposed))
    #expect(model.deciding == verdict)

    model.reasons[verdict] = " One reviewer keeps up for now. "
    try await model.decide(verdict)
    #expect(try await eventually { model.store.proposal(reallocation)?.status == .known(.rejected) })
    #expect(model.store.proposal(reallocation)?.reason == "One reviewer keeps up for now.")
    #expect(model.reasons.isEmpty)
    #expect(model.deciding == nil)
    // Decided, it no longer waits on the user, and no second decision goes.
    await #expect(throws: SubjectRefusal.notYours) {
      try await model.decide(Verdict(proposal: reallocation, choice: .approve))
    }
  }

  @Test func keepsWhatTheSheetsSayUntilItIsSentOrCancelled() async throws {
    let model = try await signedIn()
    model.advancing = exportView
    model.advanceNotes[exportView] = "Half a note"
    // Dismissed, as a swipe down or a fold that builds the sheet again does, then shown again.
    model.advancing = nil
    model.advancing = exportView
    #expect(model.advanceNotes[exportView] == "Half a note")

    let reject = Verdict(proposal: member, choice: .reject)
    model.deciding = reject
    model.reasons[reject] = "Half a reason"
    model.deciding = nil
    model.deciding = reject
    #expect(model.reasons[reject] == "Half a reason")
    #expect(model.reasons[Verdict(proposal: member, choice: .approve)] == nil)
    model.inspecting = exportView

    // Signing out forgets them, as it does the drafts.
    await model.signOut()
    #expect(model.advanceNotes.isEmpty)
    #expect(model.reasons.isEmpty)
    #expect(model.advancing == nil && model.deciding == nil && model.inspecting == nil)
  }

  @Test func namesAProposalAsTheWebDoes() async throws {
    let model = try await signedIn()
    let line = "member eng-2 as engineer on claude for demo"
    #expect(model.store.proposal(member)?.title == "Member eng-2 as engineer on claude for demo")
    #expect(model.store.entities[member]?.title == line)
    #expect(model.name(of: .thread(member)) == "Member eng-2 as engineer on claude for demo")
    let items = model.store.attention.map(AttentionItem.init)
    #expect(
      items.first { $0.id == "proposal-\(member)" }?.title
        == "Member eng-2 as engineer on claude for demo")
    #expect(model.store.titled("See \(member).") == "See \(line).")
  }

  @Test func knowsWhatAThreadIsAbout() async throws {
    let model = try await signedIn()
    guard case .task(let task)? = model.subject(of: .thread(exportView)) else {
      Issue.record("the task's thread isn't about the task")
      return
    }
    #expect(task.title == "Add the export view")
    guard case .proposal(let proposal)? = model.subject(of: .thread(member)) else {
      Issue.record("the proposal's thread isn't about the proposal")
      return
    }
    #expect(proposal.kind == .known(.member))
    #expect(model.subject(of: .general) == nil)
    #expect(model.subject(of: .thread(FakeBoard.samples)) == nil)
  }

  @Test func readsAProjectsDashboard() async throws {
    let model = try await signedIn()
    await model.store.loadDashboard("demo", using: model)
    #expect(model.store.dashboardStates["demo"] == .loaded)
    #expect(model.store.dashboards["demo"]?.body.contains("Export view") == true)
    let groups = groupTasks(model.store.tasks(of: "demo"))
    #expect(groups.map(\.phase) == [.waiting, .working])
  }

  /// An advance on its way is the only one: the sheet swiped away mid-send, then Advance again
  /// from the bar, sends nothing more, since an advance names no stage and a second would finish
  /// the next.
  @Test(.timeLimit(.minutes(1))) func sendsOneAdvanceWhileOneIsUnderWay() async throws {
    let gate = HeldBoard.Gate(paths: ["/api/verbs/advance_task"])
    let model = try await signedIn(holding: gate)
    model.advancing = exportView
    let first = Task { try await model.advance(exportView) }
    await gate.arrivals(1)
    #expect(model.underWay.contains(exportView))
    model.advancing = nil
    model.advancing = exportView
    await #expect(throws: SubjectRefusal.underWay) { try await model.advance(exportView) }
    // As the board answered the one that went, which the fake board carried out as it arrived.
    gate.answerAsArrived()
    try await first.value
    #expect(!model.underWay.contains(exportView))
    #expect(model.store.task(exportView)?.stage == "s3")
    try await Task.sleep(for: .milliseconds(300))
    #expect(gate.arrived == 1, "a second advance went")
  }

  /// A decision on its way is the only one, Approve and Reject alike.
  @Test(.timeLimit(.minutes(1))) func sendsOneDecisionWhileOneIsUnderWay() async throws {
    let gate = HeldBoard.Gate(paths: ["/api/verbs/approve", "/api/verbs/reject"])
    let model = try await signedIn(holding: gate)
    let first = Task { try await model.decide(Verdict(proposal: reallocation, choice: .approve)) }
    await gate.arrivals(1)
    #expect(model.underWay.contains(reallocation))
    let reject = Verdict(proposal: reallocation, choice: .reject)
    model.reasons[reject] = "Too late."
    await #expect(throws: SubjectRefusal.underWay) { try await model.decide(reject) }
    // As the board answered the one that went, which the fake board carried out as it arrived.
    gate.answerAsArrived()
    try await first.value
    #expect(!model.underWay.contains(reallocation))
    try await Task.sleep(for: .milliseconds(300))
    #expect(gate.arrived == 1, "a second decision went")
  }

  /// The board's refusal of an advance stays in the model, so a sheet built again still says it.
  @Test func keepsTheBoardsRefusalForTheSheet() async throws {
    let model = try await signedIn()
    // Finished elsewhere, while the app's copy still has the stage waiting on the user.
    _ = try await model.send(BoardAPI.advanceTask(exportView, note: nil))
    _ = try await model.send(BoardAPI.advanceTask(exportView, note: nil))
    #expect(model.store.task(exportView).flatMap(stageForYou) != nil)
    await #expect(throws: BoardError.self) { try await model.advance(exportView) }
    #expect(model.refusals[exportView]?.contains("not in play") == true)
    #expect(!model.underWay.contains(exportView))
  }

  /// An event that lands while a dashboard is on its first read reads it again, and the later
  /// read's answer stands, so one the board gave before the update leaves nothing out.
  @Test(.timeLimit(.minutes(1))) func readsAgainADashboardAnEventTouchesDuringItsFirstRead()
    async throws
  {
    let gate = HeldBoard.Gate(paths: ["/api/projects/demo/dashboard"])
    let model = try await signedIn(holding: gate)
    let first = Task { await model.store.loadDashboard("demo", using: model) }
    await gate.arrivals(1)
    try await writeDashboard("## Demo\n\nThe export view is in.\n", model)
    let rereading = Task { await model.reread([["dashboard", "demo"]]) }
    try #require(try await eventually { gate.arrived >= 2 }, "the event read nothing again")
    gate.answerAsArrived()
    await first.value
    await rereading.value
    #expect(model.store.dashboards["demo"]?.body == "## Demo\n\nThe export view is in.\n")
    #expect(model.store.dashboardStates["demo"] == .loaded)
  }

  /// An event reads again a dashboard whose first read failed.
  @Test(.timeLimit(.minutes(1))) func readsAgainADashboardWhoseFirstReadFailed() async throws {
    let gate = HeldBoard.Gate(paths: ["/api/projects/demo/dashboard"])
    let model = try await signedIn(holding: gate)
    let first = Task { await model.store.loadDashboard("demo", using: model) }
    await gate.arrivals(1)
    gate.fail()
    await first.value
    #expect(model.store.dashboardStates["demo"] == .failed(Loading.unreachable))
    try await writeDashboard("## Demo\n\nThe export view is in.\n", model)
    let rereading = Task { await model.reread([["dashboard", "demo"]]) }
    try #require(try await eventually { gate.arrived >= 2 }, "the event read nothing again")
    gate.answer()
    await rereading.value
    #expect(model.store.dashboards["demo"]?.body == "## Demo\n\nThe export view is in.\n")
    #expect(model.store.dashboardStates["demo"] == .loaded)
  }

  /// An event that lands while a task is read alone reads it again, and the later answer stands.
  @Test(.timeLimit(.minutes(1))) func readsAgainALoneTaskAnEventTouchesDuringItsRead()
    async throws
  {
    let gate = HeldBoard.Gate(paths: ["/api/tasks/\(exportView)"])
    let model = try await signedIn(holding: gate)
    let first = Task { await model.store.lookUpTask(exportView, using: model) }
    await gate.arrivals(1)
    _ = try await model.send(BoardAPI.advanceTask(exportView, note: nil))
    let rereading = Task { await model.reread([["task", exportView]]) }
    try #require(try await eventually { gate.arrived >= 2 }, "the event read nothing again")
    gate.answerAsArrived()
    await first.value
    await rereading.value
    #expect(model.store.task(exportView)?.stage == "s3")
  }

  /// An event reads again a task whose read alone failed.
  @Test(.timeLimit(.minutes(1))) func readsAgainALoneTaskWhoseReadFailed() async throws {
    let gate = HeldBoard.Gate(paths: ["/api/tasks/\(exportView)"])
    let model = try await signedIn(holding: gate)
    let first = Task { await model.store.lookUpTask(exportView, using: model) }
    await gate.arrivals(1)
    gate.fail()
    await first.value
    _ = try await model.send(BoardAPI.advanceTask(exportView, note: nil))
    let rereading = Task { await model.reread([["task", exportView]]) }
    try #require(try await eventually { gate.arrived >= 2 }, "the event read nothing again")
    gate.answer()
    await rereading.value
    #expect(model.store.task(exportView)?.stage == "s3")
  }
}
