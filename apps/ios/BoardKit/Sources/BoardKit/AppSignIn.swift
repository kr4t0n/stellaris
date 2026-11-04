import Foundation

/// The app's sign-in with GitHub, on a board that takes it (`AuthConfig.appLanding`). The app opens
/// `BoardAPI.appSignIn(challenge:)` in a web authentication session that waits for `landingPath` on
/// the board's own host, then trades the code the landing carries, with the verifier only the app
/// holds, at `BoardAPI.appToken(code:verifier:)` for the session (RFC 7636). The board fixes the
/// landing itself: nothing the app sends names where the browser goes.
public enum AppSignIn {
  /// Where the board lands the app's sign-in, a path on its own `https` origin.
  public static let landingPath = "/auth/app/signin"

  /// What a sign-in's landing says.
  public enum Landing: Sendable, Hashable {
    /// A one-time code to trade for the session.
    case code(String)
    /// The board's reason for turning the sign-in away: `declined`, `github`, or `not-allowed`.
    case refused(String)
  }

  /// What the address a sign-in landed at says, or nil for an address that isn't the landing.
  public static func landing(_ url: URL) -> Landing? {
    guard url.path == landingPath, let fragment = url.fragment else {
      return nil
    }
    var parts = URLComponents()
    parts.percentEncodedQuery = fragment
    let items = parts.queryItems ?? []
    if let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty {
      return .code(code)
    }
    if let reason = items.first(where: { $0.name == "signin-error" })?.value {
      return .refused(reason)
    }
    return nil
  }

  /// What iOS said when it ended a sign-in's web authentication session as cancelled, or nil when
  /// the person cancelled. iOS ends a session it refuses to start with the same `canceledLogin`,
  /// before showing anything, as for a callback host the app isn't associated with under
  /// `webcredentials`, and gives its reason in the error, which a person's cancel lacks.
  public static func refusal(ofCanceled error: NSError) -> String? {
    for key in [NSLocalizedFailureReasonErrorKey, NSLocalizedDescriptionKey] {
      let text = (error.userInfo[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
      if let text, !text.isEmpty {
        return text
      }
    }
    return nil
  }

  /// A new verifier: 32 random bytes as base64url, 43 characters, as RFC 7636 asks.
  public static func makeVerifier() -> String {
    var generator = SystemRandomNumberGenerator()
    return base64url((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
  }

  /// Base64url without padding (RFC 4648, section 5), as PKCE writes bytes.
  public static func base64url(_ bytes: [UInt8]) -> String {
    Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
