#if DEBUG
  import BoardKit
  import Foundation
  import Synchronization
  import UIKit

  /// A board at `https://board.example.com` that answers from the fixtures the server's tests
  /// captured, for the UI tests and the screenshots; debug builds only. The app uses it when
  /// launched with `STELLARIS_FAKE_BOARD` set to `apps/ios/fixtures/api`, and starts afresh when
  /// launched with `-StellarisReset`. The society's general channel holds sixty made-up messages,
  /// enough to scroll, the newest linking to a thread of samples of what a message can hold:
  /// markdown, code, a wide table, links, mentions, and images uploaded, on a task's branch, on the
  /// web at `images.example.com`, on a runner alone, and gone. It takes posts and new threads, the
  /// user's advance of a task's stage, and the user's approval or rejection of a proposal, which
  /// its reads then show to the token that wrote them alone, so tests signed in with tokens of
  /// their own see only their own writes. Any token signs in, except
  /// `refused`, which the board doesn't take, and
  /// `revoked`, which it takes for sign-in and refuses on every request after. With `fading`, every
  /// list of the channels after the first fails, as when the network goes once the board loaded,
  /// and a host under `.invalid`, which never resolves, can't be reached. Its event stream sends
  /// nothing, and its turn stream sends the captured one, stamped now, as live; both stay open,
  /// as the board's do. A token starting `replay-` gets its first turn stream's stamps again on every
  /// later connection, as the board replays its buffer.
  final class FakeBoard: URLProtocol {
    static let address = URL(string: "https://board.example.com")!
    /// The thread of samples, which general's newest message links to.
    static let samples = "0000000000000000000000SAMP"
    /// The image uploaded to the board that the samples show, and one it no longer has.
    static let uploaded = "00000000000000000000000PNG"
    static let gone = "00000000000000000000000ZZZ"
    /// A message a sample names by its id: the first sample, as the board's lookup gives it.
    static let cited = "0000000000000000000000SM01"
    /// Where the samples' image on the web is.
    static let webImages = "images.example.com"
    private static let folder = Mutex<URL?>(nil)
    /// What each token posted and opened.
    private static let written = Mutex<[String: Written]>([:])
    /// The stamp each `replay-` token's turn stream was first given.
    private static let replayStamps = Mutex<[String: String]>([:])
    /// How many times `fading` has listed the channels.
    private static let fadingListings = Mutex(0)

    /// The app's environment when it was launched against the fake board.
    static func launched() -> AppEnvironment? {
      guard let path = ProcessInfo.processInfo.environment["STELLARIS_FAKE_BOARD"] else {
        return nil
      }
      silenceConsole()
      let environment = FakeBoard.environment(
        folder: URL(fileURLWithPath: path), defaults: .standard)
      if ProcessInfo.processInfo.arguments.contains("-StellarisReset") {
        try? environment.tokens.delete(for: address)
        if let domain = Bundle.main.bundleIdentifier {
          environment.defaults.removePersistentDomain(forName: domain)
        }
      }
      return environment
    }

    /// An environment whose requests to the fake board are answered from `folder`.
    static func environment(folder: URL, defaults: UserDefaults) -> AppEnvironment {
      self.folder.withLock { $0 = folder }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [FakeBoard.self]
      return AppEnvironment(
        tokens: TokenStore(service: "stellaris.board.fake"), defaults: defaults,
        session: URLSession(configuration: configuration), gitHubHost: address.host())
    }

    override class func canInit(with request: URLRequest) -> Bool {
      guard let host = request.url?.host() else {
        return false
      }
      return host == address.host() || host == webImages || host.hasSuffix(".invalid")
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      guard let url = request.url else {
        return
      }
      if FakeBoard.unreachable(request) {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
        return
      }
      if let stream = FakeBoard.stream(request) {
        let response = HTTPURLResponse(
          url: url, statusCode: 200, httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !stream.isEmpty {
          client?.urlProtocol(self, didLoad: stream)
        }
        // Held open until the app lets go of it.
        return
      }
      if let picture = FakeBoard.picture(request) {
        let response = HTTPURLResponse(
          url: url, statusCode: 200, httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "image/png"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: picture)
        client?.urlProtocolDidFinishLoading(self)
        return
      }
      let (status, body) = FakeBoard.answer(request)
      let response = HTTPURLResponse(
        url: url, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: body)
      client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    // MARK: Answers

    /// Whether `request` fails as when nothing answers: at a host under `.invalid`, or as
    /// `fading`'s second list of the channels or a later one.
    private static func unreachable(_ request: URLRequest) -> Bool {
      if request.url?.host()?.hasSuffix(".invalid") == true {
        return true
      }
      guard request.url?.path(percentEncoded: true) == "/api/channels",
        request.value(forHTTPHeaderField: "Authorization") == "Bearer fading"
      else {
        return false
      }
      return fadingListings.withLock { listed in
        listed += 1
        return listed > 1
      }
    }

    /// What a stream the app opens sends at once, or nil for a request that is no stream or that
    /// the board refuses, which `answer` answers.
    private static func stream(_ request: URLRequest) -> Data? {
      let path = request.url?.path(percentEncoded: true) ?? ""
      let token = request.value(forHTTPHeaderField: "Authorization")
      guard request.httpMethod ?? "GET" == "GET", token != nil, token != "Bearer refused",
        token != "Bearer revoked"
      else {
        return nil
      }
      switch path {
      case "/api/events/stream":
        return Data()
      case "/api/turns/stream":
        guard let text = read("turn-stream")?["text"] as? String else {
          return nil
        }
        var now = Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(.now)
        if let token, token.hasPrefix("Bearer replay-") {
          now = replayStamps.withLock { stamps in
            let stamp = stamps[token] ?? now
            stamps[token] = stamp
            return stamp
          }
        }
        return Data(text.replacingOccurrences(of: "2026-01-01T00:00:00.000Z", with: now).utf8)
      default:
        return nil
      }
    }

    static func answer(_ request: URLRequest) -> (Int, Data) {
      let method = request.httpMethod ?? "GET"
      let path = request.url?.path(percentEncoded: true) ?? ""
      if path == "/auth/config" {
        return fixture("auth-config")
      }
      let token = request.value(forHTTPHeaderField: "Authorization")?
        .replacingOccurrences(of: "Bearer ", with: "")
      guard let token, token != "refused", token != "revoked" || path == "/api/me" else {
        return fixture("error-unauthorized")
      }
      if method == "POST", path == "/api/verbs/post_message" || path == "/api/verbs/open_thread" {
        return write(path, request: request, token: token)
      }
      if method == "POST", path == "/api/verbs/advance_task" {
        return advance(request: request, token: token)
      }
      if method == "POST", path == "/api/verbs/approve" || path == "/api/verbs/reject" {
        return decide(path, request: request, token: token)
      }
      switch (method, path) {
      case ("GET", "/api/me"): return fixture("me")
      case ("GET", "/api/society"): return fixture("society")
      case ("GET", "/api/members"): return fixture("members")
      case ("GET", "/api/scheduler"): return fixture("scheduler")
      case ("GET", "/api/projects"): return fixture("projects")
      case ("GET", "/api/channels"): return fixture("channels")
      case ("GET", "/api/channels/general"):
        return (200, json(general + posted(in: "general", by: token)))
      case ("GET", "/api/channels/demo/general"):
        let captured = body("channel") as? [Any] ?? []
        return (200, json(captured + posted(in: "demo/general", by: token)))
      case ("GET", "/api/requests"): return fixture("requests")
      case ("GET", "/api/proposals"): return (200, json(proposals(for: token)))
      case ("GET", "/api/projects/demo/tasks"): return (200, json(tasks(for: token)))
      case ("GET", "/api/projects/demo/dashboard"): return fixture("dashboard")
      case ("GET", "/api/threads"): return (200, json(threads + opened(by: token)))
      case ("GET", "/api/messages"): return (200, json(lookUp(request)))
      case ("GET", "/api/tasks/\(plot.task)/files/\(plot.path)"): return (200, json(plotFile))
      case ("DELETE", "/api/sign-in"): return fixture("sign-out")
      case ("GET", _) where path.hasPrefix("/api/channels/"):
        let ref = String(path.dropFirst("/api/channels/".count)).removingPercentEncoding ?? ""
        return (200, json(posted(in: ref, by: token)))
      case ("GET", _) where path.hasPrefix("/api/threads/"):
        return thread(String(path.dropFirst("/api/threads/".count)), token: token)
      case ("GET", _) where path.hasPrefix("/api/tasks/"):
        let id = String(path.dropFirst("/api/tasks/".count))
        guard let task = tasks(for: token).first(where: { $0["id"] as? String == id }) else {
          return fixture("error-not-found")
        }
        return (200, json(task))
      case ("GET", _) where path.hasPrefix("/api/proposals/"):
        let id = String(path.dropFirst("/api/proposals/".count))
        guard let proposal = proposals(for: token).first(where: { $0["id"] as? String == id })
        else {
          return fixture("error-not-found")
        }
        return (200, json(proposal))
      default: return fixture("error-not-found")
      }
    }

    /// A fixture's status and answer.
    private static func fixture(_ name: String) -> (Int, Data) {
      guard let file = read(name) else {
        return (500, Data())
      }
      return (file["status"] as? Int ?? 500, json(file["body"] ?? NSNull()))
    }

    private static func read(_ name: String) -> [String: Any]? {
      guard let folder = folder.withLock({ $0 }),
        let data = try? Data(contentsOf: folder.appendingPathComponent("\(name).json"))
      else {
        return nil
      }
      return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static func body(_ name: String) -> Any? { read(name)?["body"] }

    // MARK: Writes

    /// A post or a thread a token wrote, as the board would keep it.
    private struct Post: Sendable {
      let id: String
      let channel: String
      let thread: String?
      let ts: String
      let body: String
      /// What a verb recorded on the post, as JSON.
      var step: Data? = nil
    }

    private struct Opened: Sendable {
      let id: String
      let channel: String
      let title: String
      let openedAt: String
    }

    private struct Written: Sendable {
      var posts: [Post] = []
      var threads: [Opened] = []
      /// Tasks the token advanced and proposals it decided, as JSON, by id.
      var tasks: [String: Data] = [:]
      var proposals: [String: Data] = [:]
    }

    /// Takes a post or a new thread, as the user, and answers as the board does.
    private static func write(_ path: String, request: URLRequest, token: String) -> (Int, Data) {
      let input =
        bodyData(of: request).flatMap { try? JSONSerialization.jsonObject(with: $0) }
        as? [String: Any] ?? [:]
      let now = Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(.now)
      return written.withLock { written in
        var mine = written[token] ?? Written()
        defer { written[token] = mine }
        if path == "/api/verbs/open_thread" {
          let thread = Opened(
            id: String(format: "00000000000000000000THR%03d", mine.threads.count + 1),
            channel: input["channel"] as? String ?? "general",
            title: input["title"] as? String ?? "", openedAt: now)
          mine.threads.append(thread)
          return (200, json(threadRecord(thread)))
        }
        let thread = input["thread_id"] as? String
        let channel =
          thread.map { id in
            mine.threads.first { $0.id == id }?.channel
              ?? (id == samples ? "general" : capturedChannel(of: id))
          } ?? input["channel"] as? String ?? "general"
        let post = Post(
          id: String(format: "00000000000000000000PST%03d", mine.posts.count + 1),
          channel: channel, thread: thread, ts: now, body: input["body"] as? String ?? "")
        mine.posts.append(post)
        return (200, json(record(post)))
      }
    }

    // MARK: Tasks and proposals

    /// The captured tasks, as `token` advanced them.
    private static func tasks(for token: String) -> [[String: Any]] {
      let mine = written.withLock { $0[token]?.tasks ?? [:] }
      return (body("tasks") as? [[String: Any]] ?? []).map { task in
        (task["id"] as? String).flatMap { mine[$0] }.flatMap(object) ?? task
      }
    }

    /// The captured proposals, as `token` decided them.
    private static func proposals(for token: String) -> [[String: Any]] {
      let mine = written.withLock { $0[token]?.proposals ?? [:] }
      return (body("proposals") as? [[String: Any]] ?? []).map { proposal in
        (proposal["id"] as? String).flatMap { mine[$0] }.flatMap(object) ?? proposal
      }
    }

    private static func object(_ data: Data) -> [String: Any]? {
      (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// The board's refusal, as it words the state that refused it.
    private static func refusal(_ message: String) -> (Int, Data) {
      (409, json(["error": "INVALID_STATE", "message": message]))
    }

    /// Finishes the task's current stage as the user, as the board does: the stage done by the
    /// user, the task at the next stage, open, or done after its last; the note posted in its
    /// thread with the step.
    private static func advance(request: URLRequest, token: String) -> (Int, Data) {
      let input = bodyData(of: request).flatMap(object) ?? [:]
      let id = input["task_id"] as? String ?? ""
      guard var task = tasks(for: token).first(where: { $0["id"] as? String == id }) else {
        return fixture("error-not-found")
      }
      guard ["open", "claimed"].contains(task["status"] as? String ?? ""),
        task["completing"] as? Bool != true
      else {
        return refusal("task \(id) is \(task["status"] as? String ?? "") and not in play")
      }
      var stages = task["stages"] as? [[String: Any]] ?? []
      guard let index = stages.firstIndex(where: { $0["id"] as? String == task["stage"] as? String })
      else {
        return refusal("task \(id) has no stage \(task["stage"] as? String ?? "")")
      }
      let now = Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(.now)
      let next = stages.indices.contains(index + 1) ? stages[index + 1] : nil
      if next == nil, task["onDone"] as? String == "ghpr", task["pullRequest"] == nil {
        return refusal("task \(id) lands through its pull request")
      }
      var holders = stages[index]["holders"] as? [String] ?? []
      if !holders.contains("user") {
        holders.append("user")
      }
      stages[index]["holders"] = holders
      stages[index]["completedBy"] = "user"
      stages[index]["completedAt"] = now
      let stageId = stages[index]["id"] as? String ?? ""
      task["stages"] = stages
      task["claimedBy"] = nil
      task["leaseExpiresAt"] = nil
      task["updatedAt"] = now
      if let next, let nextId = next["id"] as? String {
        task["status"] = "open"
        task["stage"] = nextId
        task["stageSince"] = now
      } else {
        task["status"] = "done"
      }
      let step: [String: Any] = [
        "action": "advanced", "stage": stageId, "to": next?["id"] as? String ?? NSNull(),
      ]
      let note = input["note"] as? String
      written.withLock { written in
        var mine = written[token] ?? Written()
        mine.tasks[id] = json(task)
        if let note {
          mine.posts.append(
            Post(
              id: String(format: "00000000000000000000PST%03d", mine.posts.count + 1),
              channel: task["channel"] as? String == "general"
                ? "\(task["project"] as? String ?? "demo")/general"
                : task["channel"] as? String ?? "general",
              thread: id, ts: now, body: note, step: json(step)))
        }
        written[token] = mine
      }
      return (200, json(task))
    }

    /// Approves or rejects the proposal as the user, as the board does: the proposal decided, with
    /// the reason; the decision posted in its thread with the step, which closes the thread.
    private static func decide(_ path: String, request: URLRequest, token: String) -> (Int, Data)
    {
      let input = bodyData(of: request).flatMap(object) ?? [:]
      let id = input["proposal_id"] as? String ?? ""
      guard var proposal = proposals(for: token).first(where: { $0["id"] as? String == id }) else {
        return fixture("error-not-found")
      }
      guard proposal["status"] as? String == "proposed" else {
        return refusal("proposal \(id) is already \(proposal["status"] as? String ?? "")")
      }
      let approved = path.hasSuffix("/approve")
      let reason = input["reason"] as? String
      let now = Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(.now)
      proposal["status"] = approved ? "provisioned" : "rejected"
      proposal["decidedBy"] = "user"
      proposal["decidedAt"] = now
      proposal["reason"] = reason
      let line =
        (try? JSONDecoder().decode(Proposal.self, from: json(proposal)))
        .map { describeCharter($0.kind, $0.charter) } ?? id
      let post =
        "\(approved ? "Approved" : "Rejected"): \(line).\(reason.map { " Reason: \($0)." } ?? "")"
      let outcome = approved ? "approved" : "rejected"
      return written.withLock { written in
        var mine = written[token] ?? Written()
        defer { written[token] = mine }
        mine.proposals[id] = json(proposal)
        mine.posts.append(
          Post(
            id: String(format: "00000000000000000000PST%03d", mine.posts.count + 1),
            channel: "governance", thread: id, ts: now, body: post,
            step: json(["action": outcome])))
        let decision: [String: Any] = [
          "id": String(format: "00000000000000000000DEC%03d", mine.proposals.count),
          "proposalId": id, "decidedBy": "user", "outcome": outcome, "ts": now,
        ]
        var answer = decision
        answer["reason"] = reason
        return (200, json(answer))
      }
    }

    /// A request's body, which `URLSession` hands a protocol as a stream.
    private static func bodyData(of request: URLRequest) -> Data? {
      if let data = request.httpBody {
        return data
      }
      guard let stream = request.httpBodyStream else {
        return nil
      }
      stream.open()
      defer { stream.close() }
      var data = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        guard read > 0 else {
          break
        }
        data.append(buffer, count: read)
      }
      return data
    }

    /// The channel of the captured thread `id`, or general.
    private static func capturedChannel(of id: String) -> String {
      guard let detail = body("thread") as? [String: Any],
        let thread = detail["thread"] as? [String: Any], thread["id"] as? String == id
      else {
        return "general"
      }
      return thread["channel"] as? String ?? "general"
    }

    /// What `token` posted in the channel `ref` itself, oldest first.
    private static func posted(in ref: String, by token: String) -> [[String: Any]] {
      let posts = written.withLock { $0[token]?.posts ?? [] }
      return posts.filter { $0.channel == ref && $0.thread == nil }.map(record)
    }

    /// The threads `token` opened, as the board lists them.
    private static func opened(by token: String) -> [[String: Any]] {
      let mine = written.withLock { $0[token] ?? Written() }
      return mine.threads.map { thread in
        var summary = threadRecord(thread)
        let posts = mine.posts.filter { $0.thread == thread.id }
        summary["messages"] = posts.count
        summary["lastMessageId"] = posts.last?.id ?? NSNull()
        summary["lastAuthor"] = posts.isEmpty ? NSNull() : "user"
        return summary
      }
    }

    private static func record(_ post: Post) -> [String: Any] {
      var message: [String: Any] = [
        "id": post.id, "author": "user", "channel": post.channel, "ts": post.ts,
        "mentions": [String](), "body": post.body,
      ]
      message["thread"] = post.thread
      message["step"] = post.step.flatMap(object)
      return message
    }

    private static func threadRecord(_ thread: Opened) -> [String: Any] {
      [
        "id": thread.id, "channel": thread.channel, "title": thread.title, "state": "open",
        "openedBy": "user", "openedAt": thread.openedAt, "body": "",
      ]
    }

    // MARK: Threads

    /// A thread by its id: one `token` opened, the captured task thread, the samples, or one made
    /// up for a proposal's or a question's, titled as the board would; with what `token` posted in
    /// it after its own messages.
    private static func thread(_ id: String, token: String) -> (Int, Data) {
      let mine = written.withLock { $0[token] ?? Written() }
      let posts = mine.posts.filter { $0.thread == id }.map(record)
      if let opened = mine.threads.first(where: { $0.id == id }) {
        return (200, json(["thread": threadRecord(opened), "messages": posts]))
      }
      let (status, data) = thread(id)
      guard status == 200, !posts.isEmpty,
        var detail = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      else {
        return (status, data)
      }
      detail["messages"] = (detail["messages"] as? [Any] ?? []) + posts
      // A decision closes its proposal's thread.
      if let decided = mine.proposals[id].flatMap(object), var thread = detail["thread"] as? [String: Any] {
        thread["state"] = "closed"
        thread["closedBy"] = decided["decidedBy"]
        thread["closedAt"] = decided["decidedAt"]
        detail["thread"] = thread
      }
      return (200, json(detail))
    }

    /// A thread by its id: the captured task thread, the samples, or one made up for a proposal's
    /// or a question's, titled as the board would.
    private static func thread(_ id: String) -> (Int, Data) {
      if id == samples {
        let thread: [String: Any] = [
          "id": samples, "channel": "general", "title": "Rendering samples", "state": "open",
          "openedBy": "eng-1", "openedAt": time(0), "body": "",
        ]
        return (200, json(["thread": thread, "messages": sampleMessages]))
      }
      if let detail = body("thread") as? [String: Any],
        (detail["thread"] as? [String: Any])?["id"] as? String == id
      {
        return (200, json(detail))
      }
      var title = "A thread"
      var channel = "general"
      var subject: [String: Any]?
      if let proposals = body("proposals") as? [[String: Any]],
        let proposal = proposals.first(where: { $0["id"] as? String == id })
      {
        // As the board titles a proposal's thread: its kind, then its charter in one line.
        let line =
          (try? JSONDecoder().decode(Proposal.self, from: json(proposal)))
          .map { describeCharter($0.kind, $0.charter) } ?? ""
        title = "\(proposal["kind"] as? String ?? "") proposal: \(line)"
        channel = "governance"
        subject = ["kind": "proposal", "id": id]
      }
      // As the board titles a task's thread: the task's title, on its project's channel.
      if let tasks = body("tasks") as? [[String: Any]],
        let task = tasks.first(where: { $0["id"] as? String == id })
      {
        title = task["title"] as? String ?? title
        channel = "\(task["project"] as? String ?? "demo")/\(task["channel"] as? String ?? "general")"
        subject = ["kind": "task", "id": id]
      }
      if let requests = body("requests") as? [[String: Any]],
        let asked = requests.compactMap({ $0["thread"] as? [String: Any] })
          .first(where: { $0["id"] as? String == id })
      {
        title = asked["title"] as? String ?? title
        channel = asked["channel"] as? String ?? channel
      }
      var thread: [String: Any] = [
        "id": id, "channel": channel, "title": title, "state": "open",
        "openedBy": "concierge-1", "openedAt": time(0), "body": "",
      ]
      thread["subject"] = subject
      let message = message(
        id: "\(id)-1", author: "concierge-1", channel: channel, thread: id, minute: 0,
        body: "Opened for the decision.")
      return (200, json(["thread": thread, "messages": [message]]))
    }

    /// The id of general's message numbered `number`, shaped as the board's ids are, so a link can
    /// name it.
    static func generalId(_ number: Int) -> String {
      String(format: "000000000000000000000GEN%02d", number)
    }

    /// Sixty messages in the society's general channel, of varied lengths.
    private static var general: [[String: Any]] {
      let authors = ["eng-1", "rev-1", "concierge-1", "user"]
      let notes = [
        "The build is green on dev.",
        "Reviewing the export view now; two comments so far, both about the empty state.",
        "Docs first, then the export view. The release notes draft is in its thread.",
        "Merged. The runner picked up the new image within a minute and every turn since has passed.",
      ]
      return (1...60).map { number in
        let note =
          number == 60
          ? "The [rendering samples](/thread/\(samples)) are in their thread."
          : notes[number % notes.count]
        return message(
          id: generalId(number), author: authors[number % authors.count], channel: "general",
          thread: nil, minute: number, body: "Note \(number). \(note)")
      }
    }

    /// What a message can hold, one kind to a message, as citizens write them.
    private static var sampleMessages: [[String: Any]] {
      let task = "00000000000000000000000010"
      let bodies: [(String, String)] = [
        (
          "eng-1",
          """
          ## The export view is in

          **Done:** the export view, with *its empty state* and ~~the old CSV path~~. @rev-1, \
          it's ready for review: \(task), with the design in [its thread](/thread/\(task)).

          Run `pnpm test` before you start. The spec is at https://example.com/specs/export, and \
          the notes at www.example.com/notes.
          """
        ),
        (
          "rev-1",
          """
          Two findings:

          1. The export drops the last line when a body ends without a newline.
          2. The empty state reads `undefined` at the narrowest width.

          ```ts
          export function exportChannel(messages: readonly Message[], options: { readonly steps: boolean }): string {
            return messages.map((message) => `${message.author}: ${message.body}`).join("\\n");
          }
          ```
          """
        ),
        (
          "eng-1",
          """
          Measured at each width:

          | Width | Lines | Wraps | Where |
          |:------|------:|:-----:|:------|
          | 320 pt | 14 | yes | The narrowest Split View, where each long cell wraps at 240 points, so one cell never stretches the table past the column |
          | 410 pt | 11 | no | The outer display less its bar |
          | 669 pt | 9 | no | The inner display in portrait |
          """
        ),
        (
          "concierge-1",
          """
          Before the release, as post \(cited) says:

          - [x] Docs
          - [ ] Release notes
            - the export view first
            - then the empty state
          - [ ] The changelog

          > The export goes out before the release.

          ---

          Next: the empty state.
          """
        ),
        (
          "eng-1",
          """
          The export view at 410 pt:

          ![The export view at 410 pt](image:\(uploaded))

          A capture wider than the column: ![The export view at 1600 px](https://\(webImages)/wide.png)

          The plot on the task's branch: ![The plot](/data/worktrees/eng-1/.tasks/\(plot.task)/\(plot.path))

          On the runner alone: ![the run log](/tmp/run/log.png). And one the board no longer has: \
          ![The first draft](image:\(gone))
          """
        ),
        (
          "user",
          "Thanks. Merging \(task) once the review is in; @eng-1, the [spec](https://example.com/specs/export) wins where the notes differ, as [note 30](/c/general?message=\(generalId(30))) says."
        ),
      ]
      return bodies.enumerated().map { index, entry in
        message(
          id: "samples-\(index + 1)", author: entry.0, channel: "general", thread: samples,
          minute: index, body: entry.1)
      }
    }

    /// The board's threads as captured, and the samples.
    private static var threads: [Any] {
      let captured = body("threads") as? [Any] ?? []
      let thread: [String: Any] = [
        "id": samples, "channel": "general", "title": "Rendering samples", "state": "open",
        "openedBy": "eng-1", "openedAt": time(0), "body": "", "messages": 6,
        "lastMessageId": NSNull(), "lastAuthor": "user",
      ]
      return captured + [thread]
    }

    /// Where the messages a lookup asks about are: the one the samples cite; any other id names
    /// no message, and the answer leaves it out.
    private static func lookUp(_ request: URLRequest) -> [[String: Any]] {
      let query = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
      let ids = query?.queryItems?.first { $0.name == "ids" }?.value?.split(separator: ",") ?? []
      guard ids.contains(where: { $0 == cited }) else {
        return []
      }
      return [
        [
          "id": cited, "author": "eng-1", "channel": "general", "thread": samples, "ts": time(0),
        ]
      ]
    }

    // MARK: Pictures

    /// The image on the task's branch that the samples show.
    private static let plot = (task: "00000000000000000000000010", path: "evidence/plot.png")

    /// The board's answer for the plot, as it reads the file from the project's runner.
    private static var plotFile: [String: Any] {
      let png = drawing(width: 600, height: 360, label: "plot.png", hue: 0.33)
      return [
        "kind": "file", "path": plot.path, "size": png.count,
        "commit": ["id": "fixture-commit", "at": time(0), "author": "eng-1"],
        "content": png.base64EncodedString(),
      ]
    }

    /// A picture the fake board serves: the uploaded image the samples show, and the one on the
    /// web; nil for any other request.
    private static func picture(_ request: URLRequest) -> Data? {
      guard let url = request.url, request.httpMethod ?? "GET" == "GET" else {
        return nil
      }
      if url.host() == webImages {
        return url.path() == "/wide.png"
          ? drawing(width: 1600, height: 400, label: "1600 × 400 px", hue: 0.58) : nil
      }
      guard url.path(percentEncoded: true) == "/api/images/\(uploaded)",
        request.value(forHTTPHeaderField: "Authorization") != nil
      else {
        return nil
      }
      return drawing(width: 820, height: 492, label: "820 × 492 px", hue: 0.08)
    }

    /// A PNG `width` by `height` pixels: a field of `hue` with bars across it and `label`.
    private static func drawing(width: Int, height: Int, label: String, hue: CGFloat) -> Data {
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let size = CGSize(width: width, height: height)
      return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
        UIColor(hue: hue, saturation: 0.45, brightness: 0.32, alpha: 1).setFill()
        context.fill(CGRect(origin: .zero, size: size))
        UIColor(hue: hue, saturation: 0.55, brightness: 0.75, alpha: 1).setFill()
        let bars = 8
        let slot = size.width / CGFloat(bars + 1)
        for bar in 0..<bars {
          let tall = size.height * (0.25 + 0.5 * CGFloat((bar * 5) % bars) / CGFloat(bars))
          context.fill(
            CGRect(
              x: slot * (CGFloat(bar) + 0.6), y: size.height - tall - 24, width: slot * 0.7,
              height: tall))
        }
        let text = label as NSString
        text.draw(
          at: CGPoint(x: 24, y: 20),
          withAttributes: [
            .font: UIFont.systemFont(ofSize: size.height / 9, weight: .semibold),
            .foregroundColor: UIColor.white,
          ])
      }
    }

    private static func message(
      id: String, author: String, channel: String, thread: String?, minute: Int, body: String
    ) -> [String: Any] {
      var message: [String: Any] = [
        "id": id, "author": author, "channel": channel, "ts": time(minute), "mentions": [String](),
        "body": body,
      ]
      message["thread"] = thread
      return message
    }

    private static func time(_ minute: Int) -> String {
      String(format: "2026-01-01T%02d:%02d:00.000Z", 9 + minute / 60, minute % 60)
    }

    private static func json(_ value: Any) -> Data {
      (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data()
    }
  }

  /// Points the app's standard output and error at /dev/null. Launched by XCTest, the app writes its
  /// log, XCTest's own automation in it included, to a terminal that xcodebuild reads, and each write
  /// waits while xcodebuild reads late, as it does on a busy runner, where its reads are throttled:
  /// the app's main thread then stops inside XCTest's query. Nothing in the tests reads the console.
  private func silenceConsole() {
    let null = open("/dev/null", O_WRONLY)
    guard null >= 0 else {
      return
    }
    dup2(null, STDOUT_FILENO)
    dup2(null, STDERR_FILENO)
    close(null)
  }
#endif
