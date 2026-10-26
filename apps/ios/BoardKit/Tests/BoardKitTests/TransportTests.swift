#if canImport(Darwin)
  import Foundation
  import Security
  import Testing

  @testable import BoardKit

  /// Answers a test's requests in place of a board, by the host each test gives its own address.
  final class StubBoard: URLProtocol {
    struct Answer: Sendable {
      var status = 200
      var headers: [String: String] = [:]
      /// The body, as the pieces it arrives in.
      var pieces: [Data] = []
    }

    typealias Handler = @Sendable (URLRequest) -> Answer

    private final class Handlers: @unchecked Sendable {
      private let lock = NSLock()
      private var byHost: [String: Handler] = [:]

      subscript(host: String) -> Handler? {
        get { lock.withLock { byHost[host] } }
        set { lock.withLock { byHost[host] = newValue } }
      }
    }

    private static let handlers = Handlers()

    /// A session and an address whose requests `handler` answers; any other host is unreachable.
    static func board(_ handler: @escaping Handler) -> (URLSession, URL) {
      let host = "board-\(UUID().uuidString.lowercased()).test"
      handlers[host] = handler
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [StubBoard.self]
      return (URLSession(configuration: configuration), URL(string: "https://\(host)")!)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      guard let url = request.url, let handler = StubBoard.handlers[url.host ?? ""] else {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
        return
      }
      let answer = handler(request)
      let response = HTTPURLResponse(
        url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      for piece in answer.pieces {
        client?.urlProtocol(self, didLoad: piece)
      }
      client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
  }

  extension URLRequest {
    /// The body as a session hands it to a protocol, which is a stream.
    var sentBody: Data {
      guard let stream = httpBodyStream else { return httpBody ?? Data() }
      stream.open()
      defer { stream.close() }
      var data = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        guard count > 0 else { break }
        data.append(buffer, count: count)
      }
      return data
    }
  }

  @Suite struct TransportTests {
    @Test func sendsARequestAndDecodesTheAnswer() async throws {
      let fixture = try Fixture("post-message")
      let (input, answer) = (fixture.inputData, fixture.body)
      let (session, board) = StubBoard.board { request in
        let expected =
          request.httpMethod == "POST" && request.url?.path == "/api/verbs/post_message"
          && request.value(forHTTPHeaderField: "Authorization") == "Bearer secret"
          && request.sentBody.json == input?.json
        return expected ? StubBoard.Answer(pieces: [answer]) : StubBoard.Answer(status: 400)
      }
      let client = BoardClient(board: board, token: "secret", session: session)
      let (channel, text) = (try fixture.field("channel"), try fixture.field("body"))
      let message = try await client.send(BoardAPI.postMessage(channel: channel, body: text))
      #expect(message.author == "user")
    }

    @Test func throwsTheBoardsRefusal() async throws {
      let fixture = try Fixture("error-unauthorized")
      let (status, body) = (fixture.status, fixture.body)
      let (session, board) = StubBoard.board { _ in
        StubBoard.Answer(status: status, pieces: [body])
      }
      let client = BoardClient(board: board, token: "expired", session: session)
      let refusal = BoardError(
        status: 401, code: "UNAUTHORIZED", message: "a valid bearer token is required")
      await #expect(throws: refusal) {
        try await client.send(BoardAPI.me())
      }
    }

    @Test func throwsUnreachableWhenNoBoardAnswers() async throws {
      let (session, _) = StubBoard.board { _ in StubBoard.Answer() }
      let nowhere = URL(string: "https://nowhere.test")!
      let client = BoardClient(board: nowhere, token: "t", session: session)
      await #expect(throws: BoardError.unreachable) {
        try await client.send(BoardAPI.me())
      }
    }

    @Test func readsHowABoardSignsPeopleIn() async throws {
      let (session, board) = StubBoard.board { request in
        request.value(forHTTPHeaderField: "Authorization") == nil
          ? StubBoard.Answer(pieces: [Data(#"{"github":true}"#.utf8)])
          : StubBoard.Answer(status: 400)
      }
      #expect(await BoardClient.authConfig(board: board, session: session).github)
      let (older, address) = StubBoard.board { _ in
        StubBoard.Answer(pieces: [Data("<!doctype html>".utf8)])
      }
      #expect(await BoardClient.authConfig(board: address, session: older).github == false)
    }

    @Test func readsAnImagesBytes() async throws {
      let png = Data([0x89, 0x50, 0x4E, 0x47])
      let (session, board) = StubBoard.board { request in
        request.url?.path == "/api/images/01ARZ3NDEKTSV4RRFFQ69G5FAV"
          ? StubBoard.Answer(headers: ["Content-Type": "image/png"], pieces: [png])
          : StubBoard.Answer(status: 404)
      }
      let client = BoardClient(board: board, token: "t", session: session)
      #expect(try await client.image("01ARZ3NDEKTSV4RRFFQ69G5FAV") == png)
    }

    /// The server's recorded stream, arriving in uneven pieces with a keep-alive ping among them.
    @Test func followsTheEventStream() async throws {
      let fixture = try Fixture("event-stream")
      let text = try #require(fixture.text) + "event: ping\ndata: \n\n"
      let bytes = Array(text.utf8)
      let pieces = stride(from: 0, to: bytes.count, by: 97).map {
        Data(bytes[$0..<min($0 + 97, bytes.count)])
      }
      let since = String(try #require(fixture.path.split(separator: "=").last))
      let (session, board) = StubBoard.board { request in
        request.url?.query == "since=\(since)"
          ? StubBoard.Answer(headers: ["Content-Type": "text/event-stream"], pieces: pieces)
          : StubBoard.Answer(status: 400)
      }
      let client = BoardClient(board: board, token: "t", session: session)
      var types: [String] = []
      for try await event in client.events(since: since) {
        types.append(event.type)
      }
      // Each of the server's frames, in order, names its event's type; the ping is left out.
      let named = try #require(fixture.text).split(separator: "\n")
        .filter { $0.hasPrefix("event: ") }
        .map { String($0.dropFirst("event: ".count)) }
      #expect(named.count > 30)
      #expect(types == named)
    }

    @Test func endsTheStreamWithTheBoardsRefusal() async throws {
      let refusal = Data(#"{"error":"UNAUTHORIZED","message":"no"}"#.utf8)
      let (session, board) = StubBoard.board { _ in
        StubBoard.Answer(status: 401, pieces: [refusal])
      }
      let client = BoardClient(board: board, token: "t", session: session)
      await #expect(throws: BoardError(status: 401, code: "UNAUTHORIZED", message: "no")) {
        for try await _ in client.events(since: "latest") {}
      }
    }
  }

  /// Whether the Keychain takes this test process. The iOS simulator's turns a package's tests away
  /// with `errSecMissingEntitlement`, since they run in no app; macOS's takes them.
  private let keychainTakesThisProcess: Bool = {
    let probe: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "stellaris.board.probe",
    ]
    return SecItemCopyMatching(probe as CFDictionary, nil) != errSecMissingEntitlement
  }()

  @Suite struct TokenStoreTests {
    @Test(.enabled(if: keychainTakesThisProcess, "the Keychain turns away this test process"))
    func keepsReplacesAndForgetsAToken() throws {
      let store = TokenStore(service: "stellaris.board.test.\(UUID().uuidString)")
      let board = URL(string: "https://board.example")!
      let other = URL(string: "https://other.example")!
      defer {
        try? store.delete(for: board)
        try? store.delete(for: other)
      }
      #expect(try store.token(for: board) == nil)
      try store.save("first", for: board)
      try store.save("second", for: board)
      try store.save("elsewhere", for: other)
      #expect(try store.token(for: board) == "second")
      try store.delete(for: board)
      #expect(try store.token(for: board) == nil)
      #expect(try store.token(for: other) == "elsewhere")
    }
  }
#endif
