import BoardKit
import Foundation
import Security
import Testing

/// The Keychain as the app reaches it on iOS: from a test hosted in the app, which the
/// simulator's data-protection keychain takes, unlike BoardKit's own tests, which run in no app.
@Suite struct TokenStoreTests {
  private let store = TokenStore(service: "stellaris.board.test.\(UUID().uuidString)")
  private let board = URL(string: "https://board.example.com")!
  private let other = URL(string: "https://other.example.com")!

  @Test func keepsReplacesAndForgetsATokenPerBoard() throws {
    defer {
      try? store.delete(for: board)
      try? store.delete(for: other)
    }
    #expect(try store.token(for: board) == nil)
    try store.save("first", for: board)
    try store.save("second", for: board)
    try store.save("elsewhere", for: other)
    #expect(try store.token(for: board) == "second")
    #expect(try store.token(for: other) == "elsewhere")
    try store.delete(for: board)
    #expect(try store.token(for: board) == nil)
    #expect(try store.token(for: other) == "elsewhere")
  }

  /// The token is readable only while the device is unlocked, and never leaves it.
  @Test func keepsTheTokenOnThisDeviceWhileUnlocked() throws {
    defer { try? store.delete(for: board) }
    try store.save("secret", for: board)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: store.service,
      kSecAttrAccount as String: board.absoluteString,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    #expect(SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess)
    let attributes = try #require(result as? [String: Any])
    let accessible = try #require(attributes[kSecAttrAccessible as String] as? String)
    #expect(accessible == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
  }
}
