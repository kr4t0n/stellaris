#if canImport(CryptoKit)
  import CryptoKit
  import Foundation

  extension AppSignIn {
    /// The S256 challenge for `verifier`: the base64url of its SHA-256 (RFC 7636, section 4.2).
    /// Apple platforms only, since Linux's Foundation has no SHA-256.
    public static func challenge(for verifier: String) -> String {
      base64url(Array(SHA256.hash(data: Data(verifier.utf8))))
    }
  }
#endif
