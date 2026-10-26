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

  private var drafts: [String: String]
  /// Not observed: a view reads its anchor once, as it is built, and scrolling changes it often.
  @ObservationIgnored private var anchors: [String: String]
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let key: String

  init(board: URL, defaults: UserDefaults) {
    self.defaults = defaults
    key = "conversations.\(board.absoluteString)"
    let saved =
      defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Saved.self, from: $0) }
      ?? Saved()
    drafts = saved.drafts
    anchors = saved.anchors
  }

  func draft(_ conversation: Conversation) -> String {
    drafts[conversation.key] ?? ""
  }

  func setDraft(_ text: String, for conversation: Conversation) {
    drafts[conversation.key] = text.isEmpty ? nil : text
    save()
  }

  /// The id of the message at the foot of the conversation's view when the user last saw it.
  func anchor(_ conversation: Conversation) -> String? {
    anchors[conversation.key]
  }

  func setAnchor(_ id: String?, for conversation: Conversation) {
    guard anchors[conversation.key] != id else {
      return
    }
    anchors[conversation.key] = id
    save()
  }

  /// Drops everything kept for the board, as signing out does.
  func forget() {
    drafts = [:]
    anchors = [:]
    defaults.removeObject(forKey: key)
  }

  private func save() {
    if let data = try? JSONEncoder().encode(Saved(drafts: drafts, anchors: anchors)) {
      defaults.set(data, forKey: key)
    }
  }
}
