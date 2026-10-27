#if canImport(Darwin)
  import Foundation

  /// The board's API over `URLSession`, as one signed-in token. Apple platforms only: the event
  /// stream reads with `bytes(for:)`, which Linux's Foundation lacks.
  public struct BoardClient: Sendable {
    public let board: URL
    private let token: String
    private let session: URLSession

    public init(board: URL, token: String, session: URLSession = .shared) {
      self.board = board
      self.token = token
      self.session = session
    }

    /// How `board` lets people in. A board that answers without saying, as one from before GitHub
    /// sign-in, takes tokens only; `BoardError.unreachable` when nothing answers at the address.
    public static func authConfig(board: URL, session: URLSession = .shared) async throws
      -> AuthConfig
    {
      let request = BoardAPI.authConfig()
      do {
        let data = try await bytes(of: request.endpoint, board: board, token: nil, session: session)
        return (try? request.decode(data)) ?? AuthConfig(github: false)
      } catch let refusal as BoardError where refusal.status != 0 {
        return AuthConfig(github: false)
      }
    }

    /// Trades the code the app's sign-in with GitHub landed with, and the verifier it started with,
    /// for the session; the board's refusal as a `BoardError`.
    public static func appSession(
      board: URL, code: String, verifier: String, session: URLSession = .shared
    ) async throws -> String {
      let request = BoardAPI.appToken(code: code, verifier: verifier)
      let data = try await bytes(of: request.endpoint, board: board, token: nil, session: session)
      return try request.decode(data).session
    }

    /// The answer to `request`, or the board's refusal as a `BoardError`.
    public func send<Response>(_ request: BoardRequest<Response>) async throws -> Response {
      try request.decode(try await bytes(of: request.endpoint))
    }

    /// An uploaded image's bytes.
    public func image(_ id: String) async throws -> Data {
      try await bytes(of: BoardAPI.image(id))
    }

    /// The board's events after `since`, from one connection, until it ends or fails. Keep-alive
    /// pings are left out; following the board across drops is the caller's.
    public func events(since: String) -> AsyncThrowingStream<BoardEvent, any Error> {
      frames(of: BoardAPI.eventStream(since: since)) { frame in
        try JSONDecoder().decode(BoardEvent.self, from: Data(frame.data.utf8))
      }
    }

    /// The live turn stream after the event numbered `since`, from one connection, until it ends
    /// or fails. Pings are left out, and so is a frame of a shape this client can't read, as the
    /// web skips one its schema refuses; following the stream across drops is the caller's.
    public func turns(since: Int = 0) -> AsyncThrowingStream<LiveTurnEvent, any Error> {
      frames(of: BoardAPI.turnStream(since: since)) { frame in
        try? JSONDecoder().decode(LiveTurnEvent.self, from: Data(frame.data.utf8))
      }
    }

    /// The frames with data a stream at `endpoint` sends, each read by `read`, which leaves a
    /// frame out by giving nil and ends the stream by throwing.
    private func frames<Item: Sendable>(
      of endpoint: Endpoint, read: @escaping @Sendable (ServerSentEvent) throws -> Item?
    ) -> AsyncThrowingStream<Item, any Error> {
      let request = endpoint.urlRequest(board: board, token: token)
      let session = session
      return AsyncThrowingStream { continuation in
        let reading = Task {
          do {
            let (bytes, response) = try await session.bytes(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
              var body = Data()
              for try await byte in bytes {
                body.append(byte)
              }
              throw BoardError(status: status, body: body)
            }
            var parser = ServerSentEventParser()
            for try await byte in bytes {
              if let frame = parser.push(byte), !frame.data.isEmpty, let item = try read(frame) {
                continuation.yield(item)
              }
            }
            continuation.finish()
          } catch let error as BoardError {
            continuation.finish(throwing: error)
          } catch is CancellationError {
            continuation.finish()
          } catch let error as DecodingError {
            continuation.finish(throwing: error)
          } catch {
            continuation.finish(throwing: Task.isCancelled ? nil : BoardError.unreachable)
          }
        }
        continuation.onTermination = { _ in reading.cancel() }
      }
    }

    private func bytes(of endpoint: Endpoint) async throws -> Data {
      try await BoardClient.bytes(of: endpoint, board: board, token: token, session: session)
    }

    private static func bytes(
      of endpoint: Endpoint, board: URL, token: String?, session: URLSession
    ) async throws -> Data {
      let data: Data
      let response: URLResponse
      do {
        (data, response) = try await session.data(
          for: endpoint.urlRequest(board: board, token: token))
      } catch let error as URLError where error.code == .cancelled {
        throw CancellationError()
      } catch {
        throw BoardError.unreachable
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(status) else {
        throw BoardError(status: status, body: data)
      }
      return data
    }
  }
#endif
