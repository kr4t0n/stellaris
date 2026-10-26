import BoardKit
import Foundation

/// Where the app keeps a board's token: the Keychain, or a stand-in in tests.
protocol TokenKeeping: Sendable {
  func token(for board: URL) throws -> String?
  func save(_ token: String, for board: URL) throws
  func delete(for board: URL) throws
}

extension TokenStore: TokenKeeping {}

/// What the app runs against: the Keychain, its defaults, and the network.
struct AppEnvironment {
  var tokens: any TokenKeeping
  var defaults: UserDefaults
  var session: URLSession
  /// The host the app may sign in to with GitHub: its associated domain, from the build.
  var gitHubHost: String?

  static var live: AppEnvironment {
    AppEnvironment(
      tokens: TokenStore(), defaults: .standard, session: .shared,
      gitHubHost: Bundle.main.object(forInfoDictionaryKey: "StellarisBoardHost") as? String)
  }
}
