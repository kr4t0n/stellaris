#if DEBUG
  import BoardKit
  import Foundation
  import Synchronization

  /// A board at `https://board.example.com` that answers from the fixtures the server's tests
  /// captured, for the UI tests and the screenshots; debug builds only. The app uses it when
  /// launched with `STELLARIS_FAKE_BOARD` set to `apps/ios/fixtures/api`, and starts afresh when
  /// launched with `-StellarisReset`. The society's general channel holds sixty made-up messages,
  /// enough to scroll. Any token signs in, except `refused`, which the board doesn't take, and
  /// `revoked`, which it takes for sign-in and refuses on every request after. With `fading`, every
  /// list of the channels after the first fails, as when the network goes once the board loaded,
  /// and a host under `.invalid`, which never resolves, can't be reached. Its event stream sends
  /// nothing, and its turn stream sends the captured one, stamped now, as live; both stay open,
  /// as the board's do.
  final class FakeBoard: URLProtocol {
    static let address = URL(string: "https://board.example.com")!
    private static let folder = Mutex<URL?>(nil)
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
      return host == address.host() || host.hasSuffix(".invalid")
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
        let now = Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(.now)
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
      switch (method, path) {
      case ("GET", "/api/me"): return fixture("me")
      case ("GET", "/api/society"): return fixture("society")
      case ("GET", "/api/members"): return fixture("members")
      case ("GET", "/api/scheduler"): return fixture("scheduler")
      case ("GET", "/api/projects"): return fixture("projects")
      case ("GET", "/api/channels"): return fixture("channels")
      case ("GET", "/api/channels/general"): return (200, json(general))
      case ("GET", "/api/channels/demo/general"): return fixture("channel")
      case ("GET", "/api/requests"): return fixture("requests")
      case ("GET", "/api/proposals"): return fixture("proposals")
      case ("GET", "/api/projects/demo/tasks"): return fixture("tasks")
      case ("DELETE", "/api/sign-in"): return fixture("sign-out")
      case ("GET", _) where path.hasPrefix("/api/channels/"): return (200, json([Any]()))
      case ("GET", _) where path.hasPrefix("/api/threads/"):
        return thread(String(path.dropFirst("/api/threads/".count)))
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

    /// A thread by its id: the captured task thread, or one made up for a proposal's or a
    /// question's, titled as the board would.
    private static func thread(_ id: String) -> (Int, Data) {
      if let detail = body("thread") as? [String: Any],
        (detail["thread"] as? [String: Any])?["id"] as? String == id
      {
        return (200, json(detail))
      }
      var title = "A thread"
      var channel = "general"
      if let proposals = body("proposals") as? [[String: Any]],
        let proposal = proposals.first(where: { $0["id"] as? String == id })
      {
        title = "\((proposal["kind"] as? String ?? "").capitalized) proposal"
        channel = "governance"
      }
      if let requests = body("requests") as? [[String: Any]],
        let asked = requests.compactMap({ $0["thread"] as? [String: Any] })
          .first(where: { $0["id"] as? String == id })
      {
        title = asked["title"] as? String ?? title
        channel = asked["channel"] as? String ?? channel
      }
      let thread: [String: Any] = [
        "id": id, "channel": channel, "title": title, "state": "open",
        "openedBy": "concierge-1", "openedAt": time(0), "body": "",
      ]
      let message = message(
        id: "\(id)-1", author: "concierge-1", channel: channel, thread: id, minute: 0,
        body: "Opened for the decision.")
      return (200, json(["thread": thread, "messages": [message]]))
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
        message(
          id: String(format: "general-%02d", number), author: authors[number % authors.count],
          channel: "general", thread: nil, minute: number,
          body: "Note \(number). \(notes[number % notes.count])")
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
