import Foundation
import Observation

/// What each conversation keeps while the user is away from it, for one board: its draft and the
/// message its scroll is anchored at. Saved as it changes, so a view built again, or a fresh start,
/// gets them back.
@MainActor @Observable final class ConversationMemory {
  private struct Saved: Codable {
    var drafts: [String: String] = [:]
    var anchors: [String: String] = [:]
  }

  private var saved: Saved
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let key: String

  init(board: URL, defaults: UserDefaults) {
    self.defaults = defaults
    key = "conversations.\(board.absoluteString)"
    saved =
      defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Saved.self, from: $0) }
      ?? Saved()
  }

  func draft(_ conversation: Conversation) -> String {
    saved.drafts[conversation.key] ?? ""
  }

  func setDraft(_ text: String, for conversation: Conversation) {
    saved.drafts[conversation.key] = text.isEmpty ? nil : text
    save()
  }

  /// The id of the message at the foot of the conversation's view when the user last saw it.
  func anchor(_ conversation: Conversation) -> String? {
    saved.anchors[conversation.key]
  }

  func setAnchor(_ id: String?, for conversation: Conversation) {
    guard saved.anchors[conversation.key] != id else {
      return
    }
    saved.anchors[conversation.key] = id
    save()
  }

  /// Drops everything kept for the board, as signing out does.
  func forget() {
    saved = Saved()
    defaults.removeObject(forKey: key)
  }

  private func save() {
    if let data = try? JSONEncoder().encode(saved) {
      defaults.set(data, forKey: key)
    }
  }
}
