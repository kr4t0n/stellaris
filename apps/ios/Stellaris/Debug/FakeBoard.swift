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
  /// web at `images.example.com`, on a runner alone, and gone. Any token signs in, except
  /// `refused`, which the board doesn't take, and
  /// `revoked`, which it takes for sign-in and refuses on every request after. With `fading`, every
  /// list of the channels after the first fails, as when the network goes once the board loaded,
  /// and a host under `.invalid`, which never resolves, can't be reached. Its event stream sends
  /// nothing, and its turn stream sends the captured one, stamped now, as live; both stay open,
  /// as the board's do.
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
      case ("GET", "/api/threads"): return (200, json(threads))
      case ("GET", "/api/messages"): return (200, json(lookUp(request)))
      case ("GET", "/api/tasks/\(plot.task)/files/\(plot.path)"): return (200, json(plotFile))
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
        let note =
          number == 60
          ? "The [rendering samples](/thread/\(samples)) are in their thread."
          : notes[number % notes.count]
        return message(
          id: String(format: "general-%02d", number), author: authors[number % authors.count],
          channel: "general", thread: nil, minute: number, body: "Note \(number). \(note)")
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
          "Thanks. Merging \(task) once the review is in; @eng-1, the [spec](https://example.com/specs/export) wins where the notes differ."
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
