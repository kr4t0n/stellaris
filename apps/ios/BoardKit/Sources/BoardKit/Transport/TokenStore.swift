#if canImport(Security)
  import Foundation
  import Security

  /// The token a board signed the user in with, kept in the Keychain as a generic password per
  /// board address, readable only while the device is unlocked and never synced or restored to
  /// another device.
  public struct TokenStore: Sendable {
    public let service: String

    public init(service: String = "stellaris.board") {
      self.service = service
    }

    /// A Keychain call that failed, with the `OSStatus` it gave.
    public struct Failure: Error, Sendable, Hashable {
      public let status: OSStatus
    }

    public func token(for board: URL) throws -> String? {
      var query = item(for: board)
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      if status == errSecItemNotFound {
        return nil
      }
      guard status == errSecSuccess, let data = result as? Data else {
        throw Failure(status: status)
      }
      return String(decoding: data, as: UTF8.self)
    }

    /// Keeps `token` for `board`, in place of any it kept before.
    public func save(_ token: String, for board: URL) throws {
      try delete(for: board)
      var attributes = item(for: board)
      attributes[kSecValueData as String] = Data(token.utf8)
      attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      let status = SecItemAdd(attributes as CFDictionary, nil)
      guard status == errSecSuccess else {
        throw Failure(status: status)
      }
    }

    public func delete(for board: URL) throws {
      let status = SecItemDelete(item(for: board) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw Failure(status: status)
      }
    }

    private func item(for board: URL) -> [String: Any] {
      [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: board.absoluteString,
      ]
    }
  }
#endif
