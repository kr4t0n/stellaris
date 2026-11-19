import BoardKit
import Foundation
import Observation

/// What each conversation keeps while the user is away from it, for one board: its draft, the
/// message its scroll is anchored at, and the key of a post that went but wasn't answered. Saved as
/// it changes, so a view built again, or a fresh start, gets them back, but for the lines an
/// image's upload held: no upload outlives the sign-in it ran in, so a line saved mid-upload is
/// dropped as the drafts load.
@MainActor @Observable final class ConversationMemory {
  /// A post's text and the key it went with, sent again with it until it is answered.
  struct PendingPost: Codable, Equatable {
    let body: String
    let key: String
  }

  private struct Saved: Codable {
    var drafts: [String: String] = [:]
    var anchors: [String: String] = [:]
    /// Optional, so what an older build saved, without it, still reads.
    var pending: [String: PendingPost]? = nil
  }

  private var drafts: [String: String]
  @ObservationIgnored private var pending: [String: PendingPost]
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
    drafts = saved.drafts.mapValues(droppingUploadLines).filter { !$0.value.isEmpty }
    anchors = saved.anchors
    pending = saved.pending ?? [:]
  }

  /// The key to post `body` with in `conversation`: the one it went with before if that post had no
  /// answer, else a new one, kept until `posted` says the board answered. A changed text is a new
  /// post, so the board stores a post sent again once.
  func postKey(for body: String, in conversation: Conversation) -> String {
    if let earlier = pending[conversation.key], earlier.body == body {
      return earlier.key
    }
    let key = UUID().uuidString
    pending[conversation.key] = PendingPost(body: body, key: key)
    save()
    return key
  }

  /// The board answered the post on its way in `conversation`.
  func posted(in conversation: Conversation) {
    guard pending.removeValue(forKey: conversation.key) != nil else {
      return
    }
    save()
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
    pending = [:]
    defaults.removeObject(forKey: key)
  }

  private func save() {
    let saved = Saved(drafts: drafts, anchors: anchors, pending: pending.isEmpty ? nil : pending)
    if let data = try? JSONEncoder().encode(saved) {
      defaults.set(data, forKey: key)
    }
  }
}
