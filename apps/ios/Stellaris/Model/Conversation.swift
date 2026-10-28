/// What Chat shows: a channel by its ref (`general`, `demo/general`), or a thread by its id, where
/// a task's or a proposal's thread has its subject's id.
enum Conversation: Hashable, Codable, Sendable {
  case channel(String)
  case thread(String)

  /// The society's general channel, where every fresh start opens.
  static let general = Conversation.channel("general")

  /// What its draft and scroll position are kept under.
  var key: String {
    switch self {
    case .channel(let ref): "channel:\(ref)"
    case .thread(let id): "thread:\(id)"
    }
  }
}

/// The message a link named in a conversation: marked, and scrolled to once.
struct MessageMark: Equatable, Sendable {
  let id: String
  /// Whether the conversation has scrolled to it, after which a view built again shows where the
  /// user scrolled.
  var reached = false
}

/// A thread being written in a channel's New thread sheet.
struct NewThreadDraft: Equatable, Sendable {
  var title = ""
  var body = ""
}

/// The app's three tabs.
enum AppTab: Hashable, Sendable {
  case chat, board, needsYou
}

/// Where Chat is and the conversations it came from, oldest first. Back returns to the one before,
/// as the web's back arrow does: it follows where the user came from, not a fixed parent.
struct ChatHistory: Equatable, Sendable {
  /// How many steps back Chat keeps.
  static let limit = 50

  private(set) var current: Conversation
  private(set) var earlier: [Conversation] = []

  init(current: Conversation = .general) {
    self.current = current
  }

  /// Shows `conversation`, keeping the one it leaves; the one already shown changes nothing.
  mutating func open(_ conversation: Conversation) {
    guard conversation != current else {
      return
    }
    earlier.append(current)
    if earlier.count > ChatHistory.limit {
      earlier.removeFirst(earlier.count - ChatHistory.limit)
    }
    current = conversation
  }

  /// Where Back goes: the conversation before, or for a thread with none before it, the channel
  /// it is in, once that is known.
  func back(threadChannel: String?) -> Conversation? {
    if let last = earlier.last {
      return last
    }
    if case .thread = current, let threadChannel {
      return .channel(threadChannel)
    }
    return nil
  }

  mutating func goBack(threadChannel: String?) {
    guard let target = back(threadChannel: threadChannel) else {
      return
    }
    if earlier.isEmpty {
      current = target
    } else {
      current = earlier.removeLast()
    }
  }
}
