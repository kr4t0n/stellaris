import Foundation

/// A board's address as the user types it: `board.example.com`, or with `https://` and a path the
/// board is served under. Only `https`, since the app sends its token with every request.
enum BoardAddress {
  enum Problem: Error, Equatable {
    case empty, notHTTPS, invalid
  }

  static func parse(_ text: String) -> Result<URL, Problem> {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return .failure(.empty)
    }
    let written = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
    guard var parts = URLComponents(string: written), let scheme = parts.scheme?.lowercased()
    else {
      return .failure(.invalid)
    }
    guard scheme == "https" else {
      return .failure(.notHTTPS)
    }
    guard let host = parts.host, !host.isEmpty, parts.query == nil, parts.fragment == nil,
      parts.user == nil, parts.password == nil
    else {
      return .failure(.invalid)
    }
    parts.scheme = scheme
    parts.host = host.lowercased()
    while parts.path.hasSuffix("/") {
      parts.path.removeLast()
    }
    guard let url = parts.url else {
      return .failure(.invalid)
    }
    return .success(url)
  }
}
