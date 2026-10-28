import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Where a request goes on the board and what it sends.
public struct Endpoint: Sendable, Hashable {
  public enum Method: String, Sendable, Hashable {
    case get = "GET"
    case post = "POST"
    case delete = "DELETE"
  }

  public let method: Method
  /// The path and query from the board's address, each part encoded: `/api/channels/demo/general`.
  public let path: String
  /// A JSON body, for a verb.
  public let body: Data?
  /// Whether it carries the bearer token; `/auth/config` and the app's sign-in are asked without
  /// one.
  public let authenticated: Bool

  /// The request for a board at `board`, which may end in a path of its own, as behind a proxy.
  public func urlRequest(board: URL, token: String?) -> URLRequest {
    var base = board.absoluteString
    while base.hasSuffix("/") {
      base.removeLast()
    }
    // The path is built from encoded parts, so it always makes a URL.
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = method.rawValue
    if authenticated, let token {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    return request
  }
}

/// A request whose answer is JSON of a known shape.
public struct BoardRequest<Response: Decodable & Sendable>: Sendable {
  public let endpoint: Endpoint

  public func decode(_ data: Data) throws -> Response {
    try JSONDecoder().decode(Response.self, from: data)
  }
}

/// The requests the app makes: the board's reads, and its verbs run as the signed-in user through
/// `POST /api/verbs/:verb`, the route agents' verbs take.
public enum BoardAPI {
  public static func authConfig() -> BoardRequest<AuthConfig> {
    BoardRequest(
      endpoint: Endpoint(method: .get, path: "/auth/config", body: nil, authenticated: false))
  }

  /// Where the app's sign-in with GitHub starts, in the browser, with its PKCE challenge (S256).
  public static func appSignIn(challenge: String) -> Endpoint {
    Endpoint(
      method: .get,
      path:
        "/auth/github?landing=app&code_challenge=\(component(challenge))&code_challenge_method=S256",
      body: nil, authenticated: false)
  }

  /// Trades the code the app's sign-in landed with, and the verifier it started with, for the
  /// session.
  public static func appToken(code: String, verifier: String) -> BoardRequest<AppSession> {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    // Two strings always encode.
    let body = try! encoder.encode(CodeExchange(code: code, code_verifier: verifier))
    return BoardRequest(
      endpoint: Endpoint(method: .post, path: "/auth/app/token", body: body, authenticated: false))
  }

  public static func me() -> BoardRequest<BoardActor> { read("/api/me") }

  /// Ends a GitHub sign-in; the user's own token is not one and stays valid.
  public static func signOut() -> BoardRequest<SignedOut> {
    BoardRequest(
      endpoint: Endpoint(method: .delete, path: "/api/sign-in", body: nil, authenticated: true))
  }

  public static func society() -> BoardRequest<Society> { read("/api/society") }

  /// The roster of citizens.
  public static func members() -> BoardRequest<[Member]> { read("/api/members") }

  /// The scheduler's sessions: those in a turn, those queued, and the warm ones.
  public static func scheduler() -> BoardRequest<SchedulerView> { read("/api/scheduler") }

  public static func projects() -> BoardRequest<[Project]> { read("/api/projects") }

  public static func channels() -> BoardRequest<[ChannelSummary]> { read("/api/channels") }

  /// A channel's messages, by its ref: `general`, or `demo/general`.
  public static func channel(_ ref: String) -> BoardRequest<[Message]> {
    let parts = ref.split(separator: "/", omittingEmptySubsequences: false)
    return read("/api/channels/" + parts.map { component(String($0)) }.joined(separator: "/"))
  }

  public static func threads() -> BoardRequest<[ThreadSummary]> { read("/api/threads") }

  /// A thread and its messages; a task's or a proposal's thread has its subject's id.
  public static func thread(_ id: String) -> BoardRequest<ThreadDetail> {
    read("/api/threads/\(component(id))")
  }

  /// What citizens asked the user and the user has not answered, wherever they asked.
  public static func requests() -> BoardRequest<[UserRequest]> { read("/api/requests") }

  public static func tasks(project: String) -> BoardRequest<[BoardTask]> {
    read("/api/projects/\(component(project))/tasks")
  }

  public static func task(_ id: String) -> BoardRequest<BoardTask> {
    read("/api/tasks/\(component(id))")
  }

  public static func proposals() -> BoardRequest<[Proposal]> { read("/api/proposals") }

  public static func proposal(_ id: String) -> BoardRequest<Proposal> {
    read("/api/proposals/\(component(id))")
  }

  public static func dashboard(project: String) -> BoardRequest<Dashboard> {
    read("/api/projects/\(component(project))/dashboard")
  }

  /// The event stream after the event `since`, or from the end of the log with `latest`; each
  /// frame's data is a `BoardEvent`.
  public static func eventStream(since: String) -> Endpoint {
    Endpoint(
      method: .get, path: "/api/events/stream?since=\(component(since))", body: nil,
      authenticated: true)
  }

  /// The live turn stream after the event numbered `since`; each frame's data is a
  /// `LiveTurnEvent`. Its numbering starts over when the server does, so the sky asks from 0, as
  /// the web does, and the server replays its short buffer first.
  public static func turnStream(since: Int = 0) -> Endpoint {
    Endpoint(
      method: .get, path: "/api/turns/stream?since=\(since)", body: nil, authenticated: true)
  }

  /// A path on a task's branch, read from its project's runner: a file, or a folder.
  public static func taskFile(_ id: String, path: String) -> BoardRequest<BranchFile> {
    let rest = path.split(separator: "/").map { "/" + component(String($0)) }.joined()
    return read("/api/tasks/\(component(id))/files\(rest)")
  }

  /// An image a citizen uploaded, as its bytes.
  public static func image(_ id: String) -> Endpoint {
    Endpoint(method: .get, path: "/api/images/\(component(id))", body: nil, authenticated: true)
  }

  /// A post in a channel.
  public static func postMessage(channel: String, body: String) -> BoardRequest<Message> {
    fixed("post_message", PostInput(channel: channel, thread_id: nil, body: body))
  }

  /// A post in a thread.
  public static func postMessage(thread: String, body: String) -> BoardRequest<Message> {
    fixed("post_message", PostInput(channel: nil, thread_id: thread, body: body))
  }

  public static func openThread(channel: String, title: String) -> BoardRequest<BoardThread> {
    fixed("open_thread", OpenThreadInput(channel: channel, title: title))
  }

  /// Finishes the task's current stage as the user, with a note for its thread.
  public static func advanceTask(_ id: String, note: String?) -> BoardRequest<BoardTask> {
    fixed("advance_task", AdvanceInput(task_id: id, note: note))
  }

  public static func approve(_ proposal: String, reason: String? = nil) -> BoardRequest<Decision> {
    fixed("approve", DecideInput(proposal_id: proposal, reason: reason))
  }

  public static func reject(_ proposal: String, reason: String) -> BoardRequest<Decision> {
    fixed("reject", DecideInput(proposal_id: proposal, reason: reason))
  }

  /// Any verb, with its input's fields named as the verb's schema names them.
  public static func verb<Input: Encodable, Response>(
    _ name: String, _ input: Input
  ) throws -> BoardRequest<Response> {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return BoardRequest(
      endpoint: Endpoint(
        method: .post, path: "/api/verbs/\(component(name))", body: try encoder.encode(input),
        authenticated: true))
  }

  /// A verb whose input holds strings alone, which always encode.
  private static func fixed<Input: Encodable, Response>(
    _ name: String, _ input: Input
  ) -> BoardRequest<Response> {
    try! verb(name, input)
  }

  private static func read<Response>(_ path: String) -> BoardRequest<Response> {
    BoardRequest(endpoint: Endpoint(method: .get, path: path, body: nil, authenticated: true))
  }

  /// What `encodeURIComponent` leaves as it is.
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

  /// One part of a path or a query value, encoded as the web encodes it.
  static func component(_ part: String) -> String {
    part.addingPercentEncoding(withAllowedCharacters: unreserved) ?? part
  }

  // Field names as the verbs' schemas spell them; nil fields are left out.
  private struct PostInput: Encodable {
    let channel: String?
    let thread_id: String?
    let body: String
  }

  private struct OpenThreadInput: Encodable {
    let channel: String
    let title: String
  }

  private struct AdvanceInput: Encodable {
    let task_id: String
    let note: String?
  }

  private struct DecideInput: Encodable {
    let proposal_id: String
    let reason: String?
  }

  private struct CodeExchange: Encodable {
    let code: String
    let code_verifier: String
  }
}
