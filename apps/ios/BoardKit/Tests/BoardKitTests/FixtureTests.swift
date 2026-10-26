import Foundation
import Testing

@testable import BoardKit

/// Every answer the server gave in the fixtures decodes, and every request is the one BoardKit
/// builds for it.
@Suite struct FixtureTests {
  @Test func everyFixtureHasACheck() {
    #expect(Fixture.names == FixtureTests.checked.sorted())
  }

  @Test(arguments: FixtureTests.checked)
  func fixture(_ name: String) throws {
    let fixture = try Fixture(name)
    switch name {
    case "auth-config":
      #expect(try check(fixture, BoardAPI.authConfig()).github == false)
    case "me":
      #expect(try check(fixture, BoardAPI.me()).name == "user")
    case "sign-out":
      #expect(try check(fixture, BoardAPI.signOut()).signedOut == false)
    case "society":
      #expect(try check(fixture, BoardAPI.society()).channels.contains("general"))
    case "projects":
      #expect(try check(fixture, BoardAPI.projects()).map(\.slug) == ["demo"])
    case "channels":
      let channels = try check(fixture, BoardAPI.channels())
      #expect(channels.contains { $0.ref == "demo/general" && $0.project == "demo" })
    case "channel":
      let messages = try fixture.decode([Message].self)
      try check(fixture, BoardAPI.channel(try #require(messages.first).channel))
    case "threads":
      let threads = try check(fixture, BoardAPI.threads())
      #expect(threads.contains { $0.thread.subject?.kind == .known(.task) })
    case "thread":
      let detail = try fixture.decode(ThreadDetail.self)
      try check(fixture, BoardAPI.thread(detail.thread.id))
      let step = try #require(detail.messages.first?.step)
      #expect(step == .task(TaskStep(action: .known(.advanced), stage: "s1", to: "s2")))
    case "requests":
      let requests = try check(fixture, BoardAPI.requests())
      #expect(requests.map { $0.thread == nil } == [true, false])
    case "tasks":
      let tasks = try fixture.decode([BoardTask].self)
      try check(fixture, BoardAPI.tasks(project: try #require(tasks.first).project))
      #expect(tasks.map(\.status) == [.known(.open), .known(.claimed)])
    case "task":
      let task = try fixture.decode(BoardTask.self)
      try check(fixture, BoardAPI.task(task.id))
      #expect(task.stages.map(\.gate) == [false, true, true])
    case "proposals":
      let proposals = try check(fixture, BoardAPI.proposals())
      #expect(proposals.map(\.kind.value) == [.member, .channel, .reallocation])
    case "proposal":
      let proposal = try fixture.decode(Proposal.self)
      try check(fixture, BoardAPI.proposal(proposal.id))
      #expect(proposal.charter["memberships"] == .array([.string("demo")]))
    case "dashboard":
      let dashboard = try fixture.decode(Dashboard.self)
      try check(fixture, BoardAPI.dashboard(project: dashboard.project))
      #expect(dashboard.updatedBy == "eng-1")
    case "post-message":
      let (channel, body) = (try fixture.field("channel"), try fixture.field("body"))
      let message = try check(fixture, BoardAPI.postMessage(channel: channel, body: body))
      #expect(message.thread == nil)
    case "post-message-thread":
      let (thread, body) = (try fixture.field("thread_id"), try fixture.field("body"))
      let message = try check(fixture, BoardAPI.postMessage(thread: thread, body: body))
      #expect(message.thread == fixture.optionalField("thread_id"))
    case "open-thread":
      let (channel, title) = (try fixture.field("channel"), try fixture.field("title"))
      let thread = try check(fixture, BoardAPI.openThread(channel: channel, title: title))
      #expect(thread.state == .known(.open))
    case "advance-task":
      let task = try check(
        fixture,
        BoardAPI.advanceTask(try fixture.field("task_id"), note: fixture.optionalField("note")))
      #expect(task.stage == "s3")
    case "approve":
      let decision = try check(fixture, BoardAPI.approve(try fixture.field("proposal_id")))
      #expect(decision.outcome == .known(.approved))
    case "reject":
      let decision = try check(
        fixture,
        BoardAPI.reject(try fixture.field("proposal_id"), reason: try fixture.field("reason")))
      #expect(decision.outcome == .known(.rejected))
    case "error-unauthorized":
      let error = try refusal(fixture, BoardAPI.me().endpoint)
      #expect(error.isUnauthorized && error.code == "UNAUTHORIZED")
    case "error-not-found":
      let id = String(try #require(fixture.path.split(separator: "/").last))
      #expect(try refusal(fixture, BoardAPI.task(id).endpoint).code == "NOT_FOUND")
    case "error-refused":
      let request = BoardAPI.approve(try fixture.field("proposal_id"))
      #expect(try refusal(fixture, request.endpoint).code == "INVALID_STATE")
    case "event-stream":
      let since = String(try #require(fixture.path.split(separator: "=").last))
      expectEndpoint(fixture, BoardAPI.eventStream(since: since))
      #expect(fixture.status == 200)
      #expect(try #require(fixture.text).hasPrefix("event: message.posted\n"))
    default:
      Issue.record("no check for the fixture \(name)")
    }
  }

  /// What the user sees on opening the app over the fixtures' society: the three proposals, the
  /// task at the user's stage, and both questions, in the web's order.
  @Test func needsYouOverTheCapturedBoard() throws {
    let items = needsYou(
      proposals: try Fixture("proposals").decode([Proposal].self),
      tasks: try Fixture("tasks").decode([BoardTask].self),
      requests: try Fixture("requests").decode([UserRequest].self))
    let kinds = items.map { item -> String in
      switch item {
      case .proposal(let proposal, _): "proposal \(proposal.kind.rawValue)"
      case .stage(let task, let stage, _): "stage \(task.title) \(stage.id)"
      case .request(let message, _, _): "request \(message.author)"
      }
    }
    #expect(
      kinds == [
        "proposal member", "proposal channel", "proposal reallocation",
        "stage Add the export view s2", "request eng-1", "request concierge-1",
      ])
  }

  static let checked = [
    "auth-config", "me", "sign-out", "society", "projects", "channels", "channel", "threads",
    "thread", "requests", "tasks", "task", "proposals", "proposal", "dashboard", "post-message",
    "post-message-thread", "open-thread", "advance-task", "approve", "reject",
    "error-unauthorized", "error-not-found", "error-refused", "event-stream",
  ]

  @discardableResult
  private func check<Response>(_ fixture: Fixture, _ request: BoardRequest<Response>) throws
    -> Response
  {
    expectEndpoint(fixture, request.endpoint)
    #expect(fixture.status == 200)
    return try request.decode(fixture.body)
  }

  private func refusal(_ fixture: Fixture, _ endpoint: Endpoint) throws -> BoardError {
    expectEndpoint(fixture, endpoint)
    #expect(fixture.status >= 400)
    let error = BoardError(status: fixture.status, body: fixture.body)
    #expect(!error.message.isEmpty && !error.code.hasPrefix("HTTP_"))
    return error
  }

  private func expectEndpoint(_ fixture: Fixture, _ endpoint: Endpoint) {
    #expect(endpoint.method.rawValue == fixture.method)
    #expect(endpoint.path == fixture.path)
    #expect(endpoint.body?.json == fixture.inputData?.json)
  }
}
