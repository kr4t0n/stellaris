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
      let config = try check(fixture, BoardAPI.authConfig())
      #expect(config.github && config.appLanding)
    case "app-sign-in":
      let query = try #require(URLComponents(string: fixture.path)?.queryItems)
      let challenge = try #require(query.first { $0.name == "code_challenge" }?.value)
      expectEndpoint(fixture, BoardAPI.appSignIn(challenge: challenge))
      // The board took the challenge and sent the browser on to GitHub.
      #expect(fixture.status == 302)
      let location = try #require(fixture.location)
      #expect(URL(string: location)?.host == "github.com")
    case "app-landing":
      #expect(try landing(fixture) == .code("fixture-code"))
    case "app-landing-refused":
      #expect(try landing(fixture) == .refused("not-allowed"))
    case "app-token":
      let request = BoardAPI.appToken(
        code: try fixture.field("code"), verifier: try fixture.field("code_verifier"))
      #expect(try check(fixture, request).session == "fixture-session")
    case "error-app-token":
      let request = BoardAPI.appToken(
        code: try fixture.field("code"), verifier: try fixture.field("code_verifier"))
      let error = try refusal(fixture, request.endpoint)
      #expect(error.status == 400 && error.code == "invalid_grant")
    case "me":
      let actor = try check(fixture, BoardAPI.me())
      #expect(actor.name == "user" && actor.signIn == nil)
    case "me-signed-in":
      let signIn = try #require(try check(fixture, BoardAPI.me()).signIn)
      #expect(signIn.login == "fixture-login")
      #expect(signIn.avatarUrl == "https://github.com/fixture-login.png")
    case "sign-out":
      #expect(try check(fixture, BoardAPI.signOut()).signedOut == false)
    case "sign-out-signed-in":
      #expect(try check(fixture, BoardAPI.signOut()).signedOut == true)
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
      #expect(messages.allSatisfy { $0.notice == nil })
    case "channel-notice":
      let messages = try fixture.decode([Message].self)
      try check(fixture, BoardAPI.channel(try #require(messages.first).channel))
      let notice = KnowledgeNotice(action: .known(.written), topic: "release-flow", project: "demo")
      #expect(messages.last?.notice == .knowledge(notice))
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
    case "members":
      let members = try check(fixture, BoardAPI.members())
      #expect(members.map(\.name) == ["concierge-1", "eng-1", "rev-1", "user"])
      #expect(members.allSatisfy { $0.role != nil })
      #expect(members.first { $0.name == "user" }?.cli == nil)
    case "scheduler":
      let scheduler = try check(fixture, BoardAPI.scheduler())
      #expect(scheduler.paused == false)
    case "task-file":
      let file = try fixture.decode(BranchFile.self)
      let task = try Fixture("task").decode(BoardTask.self)
      try check(fixture, BoardAPI.taskFile(task.id, path: file.path))
      #expect(file.kind == .known(.file))
      #expect(file.data?.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))
    case "turn-stream":
      expectEndpoint(fixture, BoardAPI.turnStream(since: 0))
      #expect(fixture.status == 200)
      var parser = ServerSentEventParser()
      let frames = parser.push(contentsOf: Array(try #require(fixture.text).utf8))
      #expect(frames.allSatisfy { $0.event == "turn" })
      let items = try frames.map {
        try JSONDecoder().decode(LiveTurnEvent.self, from: Data($0.data.utf8))
      }
      #expect(items.map(\.seq) == [1, 2, 3, 4, 5])
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

  /// The sky over the fixtures' society, and what the captured turn stream sets off in it while
  /// it is new: the post's first line rises from its author's star, a command only flickers it,
  /// and a step that calls no tool sets off nothing.
  @Test func theTurnStreamMovesTheCapturedSky() throws {
    let model = skyModel(
      SkySnapshot(
        members: try Fixture("members").decode([Member].self),
        projects: try Fixture("projects").decode([Project].self),
        scheduler: try Fixture("scheduler").decode(SchedulerView.self),
        tasks: try Fixture("tasks").decode([BoardTask].self)))
    #expect(model.stars.map(\.id) == ["concierge-1", "eng-1", "rev-1"])
    var parser = ServerSentEventParser()
    let text = try #require(try Fixture("turn-stream").text)
    let items = try parser.push(contentsOf: Array(text.utf8))
      .map { try JSONDecoder().decode(LiveTurnEvent.self, from: Data($0.data.utf8)) }
    let first = try #require(items.first)
    let stamped = try #require(parseBoardTime(first.ts))
    let now = stamped.addingTimeInterval(1)
    #expect(
      items.map { skyCue(for: $0, in: model, now: now) } == [
        nil, SkyCue(star: "eng-1", line: "The export view is in"), SkyCue(star: "eng-1", line: nil),
        nil, SkyCue(star: "concierge-1", line: nil),
      ])
    // The same stream replayed on connect, sixteen seconds on, is history and moves nothing.
    #expect(items.allSatisfy { skyCue(for: $0, in: model, now: stamped.addingTimeInterval(16)) == nil })
  }

  static let checked = [
    "auth-config", "app-sign-in", "app-landing", "app-landing-refused", "app-token",
    "error-app-token", "me", "me-signed-in", "sign-out", "sign-out-signed-in", "society", "projects",
    "channels", "channel", "channel-notice", "threads",
    "thread", "requests", "tasks", "task", "proposals", "proposal", "dashboard", "post-message",
    "post-message-thread", "open-thread", "advance-task", "approve", "reject",
    "error-unauthorized", "error-not-found", "error-refused", "event-stream", "members",
    "scheduler", "task-file", "turn-stream",
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

  /// What the app reads of where a sign-in step sent the browser, on a board at any address.
  private func landing(_ fixture: Fixture) throws -> AppSignIn.Landing? {
    #expect(fixture.status == 302)
    let board = try #require(URL(string: "https://board.example"))
    let location = try #require(fixture.location)
    let address = try #require(URL(string: location, relativeTo: board))
    return AppSignIn.landing(address.absoluteURL)
  }

  private func expectEndpoint(_ fixture: Fixture, _ endpoint: Endpoint) {
    #expect(endpoint.method.rawValue == fixture.method)
    #expect(endpoint.path == fixture.path)
    #expect(endpoint.body?.json == fixture.inputData?.json)
  }
}
