import Foundation

/// A request the board refused, with the reason it gave as `{error, message}`, or one that never
/// reached it.
public struct BoardError: Error, Sendable, Hashable {
  /// The HTTP status, or 0 when the board could not be reached.
  public let status: Int
  /// The board's code, such as `UNAUTHORIZED`, `NOT_FOUND`, or `INVALID_STATE`.
  public let code: String
  public let message: String

  public init(status: Int, code: String, message: String) {
    self.status = status
    self.code = code
    self.message = message
  }

  /// The board no longer takes the token, which sends the app back to sign-in.
  public var isUnauthorized: Bool { status == 401 }

  public static let unreachable = BoardError(
    status: 0, code: "UNREACHABLE", message: "The board server is not reachable.")

  private struct Body: Decodable {
    let error: String
    let message: String
  }

  /// The refusal in an answer's body; one without the board's shape, as from a proxy, keeps its
  /// status alone.
  public init(status: Int, body: Data) {
    if let refusal = try? JSONDecoder().decode(Body.self, from: body) {
      self.init(status: status, code: refusal.error, message: refusal.message)
    } else {
      self.init(status: status, code: "HTTP_\(status)", message: "The board answered \(status).")
    }
  }
}
