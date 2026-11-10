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
      let projects = try check(fixture, BoardAPI.projects())
      #expect(projects.map(\.slug) == ["demo"])
      // Read once a turn has run there, so it names the runner the project lives on.
      #expect(projects.first?.runner == "runner-1")
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
    case "thread-decided":
      let detail = try fixture.decode(ThreadDetail.self)
      try check(fixture, BoardAPI.thread(detail.thread.id))
      #expect(detail.thread.subject?.kind == .known(.proposal))
      #expect(detail.thread.state == .known(.closed))
      let step = try #require(detail.messages.last?.step)
      #expect(step == .proposal(ProposalStep(action: .known(.approved))))
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
    case "upload-image":
      let image = try #require(fixture.image)
      let request = BoardAPI.uploadImage(image, name: try queryName(fixture))
      expectUpload(fixture, request.endpoint)
      #expect(fixture.status == 200)
      let uploaded = try request.decode(fixture.body)
      #expect(uploaded.type == .known(.png) && uploaded.size == image.count)
      #expect(uploaded.markdown == "![plot.png](image:\(uploaded.id))")
    case "error-upload-image":
      let request = BoardAPI.uploadImage(try #require(fixture.image), name: try queryName(fixture))
      expectUpload(fixture, request.endpoint)
      let error = BoardError(status: fixture.status, body: fixture.body)
      #expect(error.status == 400 && error.code == "VALIDATION")
      #expect(error.message == "notes.txt is not a PNG, JPEG, GIF, or WebP image by its first bytes")
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
    case "messages":
      // Asked for one message the board has and one it doesn't, which the answer leaves out.
      let query = try #require(fixture.path.split(separator: "=").last)
      let ids = query.split(separator: ",").map(String.init)
      let refs = try check(fixture, BoardAPI.messages(ids))
      #expect(ids.count == 2)
      #expect(refs.map(\.id) == [ids[0]])
      #expect(refs.first?.channel == "demo/general" && refs.first?.thread == nil)
    case "task-file":
      let file = try fixture.decode(BranchFile.self)
      let task = try Fixture("task").decode(BoardTask.self)
      try check(fixture, BoardAPI.taskFile(task.id, path: file.path))
      #expect(file.kind == .known(.file))
      #expect(file.data?.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))
      #expect(file.size == 70 && file.commit.author == "eng-1" && file.entries == nil)
    case "task-files":
      let task = try Fixture("task").decode(BoardTask.self)
      let root = try check(fixture, BoardAPI.taskFile(task.id, path: ""))
      #expect(root.kind == .known(.dir) && root.path.isEmpty && root.size == nil)
      #expect(root.entries == [BranchEntry(name: "evidence", kind: .known(.dir))])
    case "task-folder":
      let task = try Fixture("task").decode(BoardTask.self)
      let folder = try check(fixture, BoardAPI.branchFile(.task(task.id), path: "evidence"))
      #expect(folder.path == "evidence" && folder.commit.id == "fixture-commit")
      #expect(
        entriesInOrder(folder.entries ?? []) == [
          BranchEntry(name: "notes.md", kind: .known(.file), size: 58),
          BranchEntry(name: "plot.png", kind: .known(.file), size: 70),
        ])
    case "task-text-file":
      let task = try Fixture("task").decode(BoardTask.self)
      let file = try check(fixture, BoardAPI.taskFile(task.id, path: "evidence/notes.md"))
      #expect(file.size == 58)
      #expect(
        viewOf(file.path, file.data ?? Data())
          == .markdown("# Notes\n\nThe [plot](plot.png) shows the export's timings.\n"))
    case "project-files":
      let root = try check(fixture, BoardAPI.projectFile("demo", path: ""))
      // The project's default branch as its runner's first commit left it.
      #expect(root.kind == .known(.dir) && root.entries == [])
      #expect(root.commit.author == "stellaris-board")
    case "error-file-missing":
      let error = try refusal(fixture, BoardAPI.projectFile("demo", path: "README.md").endpoint)
      #expect(error.status == 404 && error.code == "NOT_FOUND")
    case "error-runner-away":
      let error = try refusal(fixture, BoardAPI.projectFile("demo", path: "").endpoint)
      #expect(error.status == 503 && error.code == "RUNNER_AWAY")
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
    // Replayed sooner, by a connection made again, what the sky has played through moves nothing,
    // and what came after it still does.
    let last = try #require(items.last)
    let played = try #require(parseBoardTime(last.ts))
    #expect(items.allSatisfy { skyCue(for: $0, in: model, now: now, playedThrough: played) == nil })
    let earlier = played.addingTimeInterval(-0.001)
    #expect(
      items.map { skyCue(for: $0, in: model, now: now, playedThrough: earlier) }
        == items.map { item in
          parseBoardTime(item.ts).map { $0 > earlier } == true
            ? skyCue(for: item, in: model, now: now) : nil
        })
  }

  static let checked = [
    "auth-config", "app-sign-in", "app-landing", "app-landing-refused", "app-token",
    "error-app-token", "me", "me-signed-in", "sign-out", "sign-out-signed-in", "society", "projects",
    "channels", "channel", "channel-notice", "threads",
    "thread", "thread-decided", "requests", "tasks", "task", "proposals", "proposal", "dashboard",
    "post-message", "upload-image", "error-upload-image",
    "post-message-thread", "open-thread", "advance-task", "approve", "reject",
    "error-unauthorized", "error-not-found", "error-refused", "event-stream", "members",
    "messages", "scheduler", "task-file", "turn-stream", "task-files", "task-folder",
    "task-text-file", "project-files", "error-file-missing", "error-runner-away",
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

  /// The file name an image was posted under, from its request's query.
  private func queryName(_ fixture: Fixture) throws -> String {
    let query = try #require(URLComponents(string: fixture.path)?.queryItems)
    return try #require(query.first { $0.name == "name" }?.value)
  }

  /// An image's request: its bytes are the body, of the media type its first bytes tell.
  private func expectUpload(_ fixture: Fixture, _ endpoint: Endpoint) {
    #expect(endpoint.method.rawValue == fixture.method)
    #expect(endpoint.path == fixture.path)
    #expect(endpoint.contentType == fixture.contentType)
    #expect(endpoint.body == fixture.image)
  }

  private func expectEndpoint(_ fixture: Fixture, _ endpoint: Endpoint) {
    #expect(endpoint.method.rawValue == fixture.method)
    #expect(endpoint.path == fixture.path)
    #expect(endpoint.body?.json == fixture.inputData?.json)
  }
}
