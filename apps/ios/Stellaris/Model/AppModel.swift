import BoardKit
import Foundation
import Observation

/// Why a sign-in didn't take.
enum SignInFailure: Error, Equatable {
  /// The board answered that it doesn't take the token.
  case refused
  case unreachable
  /// The Keychain wouldn't keep the token.
  case keychain
}

/// The app's state: whether it is signed in and to which board, the board as last loaded, which tab
/// is open, and Chat's history. A fresh start opens the society's general channel; coming back from
/// the background keeps what was open, since the model lives as long as the app does.
@MainActor @Observable final class AppModel {
  enum Phase: Equatable {
    case starting, signedOut, signedIn
  }

  private(set) var phase: Phase = .starting
  /// The board signed in to, or the last one, which sign-in offers again.
  private(set) var board: URL?
  /// Who the token signs in as, once the board has said.
  private(set) var actor: BoardActor?
  /// Why the app is back at sign-in, when the board ended the sign-in.
  private(set) var notice: String?
  var tab: AppTab = .chat
  var showsSettings = false
  private(set) var history = ChatHistory()
  private(set) var memory: ConversationMemory?
  let store = BoardStore()

  @ObservationIgnored let environment: AppEnvironment
  @ObservationIgnored private var client: BoardClient?
  /// Counts sign-ins, so a refusal of an earlier one's token ends nothing.
  @ObservationIgnored private var generation = 0
  /// Each conversation's messages as last loaded, kept while the app is signed in.
  @ObservationIgnored private var feeds: [Conversation: ConversationFeed] = [:]

  private static let boardKey = "board"

  init(environment: AppEnvironment) {
    self.environment = environment
    board = environment.defaults.string(forKey: AppModel.boardKey).flatMap(URL.init(string:))
  }

  /// At launch: back into the board the app was signed in to, or to sign-in.
  func start() async {
    guard phase == .starting else {
      return
    }
    guard let board, let token = try? environment.tokens.token(for: board) else {
      phase = .signedOut
      return
    }
    let client = BoardClient(board: board, token: token, session: environment.session)
    do {
      enter(board: board, client: client, actor: try await client.send(BoardAPI.me()))
    } catch let error as BoardError where error.isUnauthorized {
      try? environment.tokens.delete(for: board)
      phase = .signedOut
      notice = AppModel.ended
    } catch {
      // The board can't be reached now; each view says so and tries again.
      enter(board: board, client: client, actor: nil)
    }
  }

  /// Signs in to `board` with a token the user pasted or a GitHub sign-in ended in, once the
  /// board takes it, and keeps the token in the Keychain.
  func signIn(board: URL, token: String) async throws {
    let client = BoardClient(board: board, token: token, session: environment.session)
    let actor: BoardActor
    do {
      actor = try await client.send(BoardAPI.me())
    } catch let error as BoardError where error.isUnauthorized {
      throw SignInFailure.refused
    } catch {
      throw SignInFailure.unreachable
    }
    do {
      try environment.tokens.save(token, for: board)
    } catch {
      throw SignInFailure.keychain
    }
    environment.defaults.set(board.absoluteString, forKey: AppModel.boardKey)
    enter(board: board, client: client, actor: actor)
  }

  /// Signs out: ends a GitHub sign-in on the board too, and forgets the token and every draft.
  func signOut() async {
    if let client, actor?.signIn != nil {
      _ = try? await client.send(BoardAPI.signOut())
    }
    if let board {
      try? environment.tokens.delete(for: board)
    }
    memory?.forget()
    leave(notice: nil)
  }

  /// A request as the signed-in user. A token the board no longer takes ends the sign-in, and the
  /// app goes back to sign-in.
  func send<Response>(_ request: BoardRequest<Response>) async throws -> Response {
    guard let client else {
      throw CancellationError()
    }
    let sent = generation
    do {
      return try await client.send(request)
    } catch let error as BoardError where error.isUnauthorized {
      if sent == generation, phase == .signedIn {
        if let board {
          try? environment.tokens.delete(for: board)
        }
        leave(notice: AppModel.ended)
      }
      throw error
    }
  }

  /// Loads the board again: what Board and Needs you show, and who the token signs in as.
  func refresh() async {
    if actor == nil {
      actor = try? await send(BoardAPI.me())
    }
    await store.refresh(using: self)
  }

  // MARK: Chat

  /// Shows `conversation` in Chat, which Back then leaves for the one shown before.
  func open(_ conversation: Conversation) {
    history.open(conversation)
    tab = .chat
  }

  /// Where Back in Chat goes, if anywhere.
  var back: Conversation? {
    history.back(threadChannel: feed(for: history.current).thread?.channel)
  }

  func goBack() {
    history.goBack(threadChannel: feed(for: history.current).thread?.channel)
  }

  /// The conversation's messages, as last loaded.
  func feed(for conversation: Conversation) -> ConversationFeed {
    if let feed = feeds[conversation] {
      return feed
    }
    let feed = ConversationFeed(conversation: conversation)
    feeds[conversation] = feed
    return feed
  }

  /// What a conversation is called: `#general`, or a thread's title once it is known.
  func name(of conversation: Conversation) -> String {
    switch conversation {
    case .channel(let ref):
      return "#" + (ref.split(separator: "/").last.map(String.init) ?? ref)
    case .thread(let id):
      if let thread = feeds[conversation]?.thread {
        return thread.title
      }
      return store.tasks.first { $0.id == id }?.title ?? "the thread"
    }
  }

  // MARK: Entering and leaving

  private static let ended = "The board ended this sign-in."

  private func enter(board: URL, client: BoardClient, actor: BoardActor?) {
    generation += 1
    self.board = board
    self.client = client
    self.actor = actor
    memory = ConversationMemory(board: board, defaults: environment.defaults)
    history = ChatHistory()
    feeds = [:]
    tab = .chat
    notice = nil
    phase = .signedIn
    Task { await store.refresh(using: self) }
  }

  private func leave(notice: String?) {
    generation += 1
    client = nil
    actor = nil
    memory = nil
    feeds = [:]
    store.clear()
    history = ChatHistory()
    showsSettings = false
    self.notice = notice
    phase = .signedOut
  }
}
