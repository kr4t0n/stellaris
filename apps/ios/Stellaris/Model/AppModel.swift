import BoardKit
import Foundation
import Observation

/// What following a link did: opened what it names in Chat, asks for Safari, or went nowhere.
enum LinkOutcome: Equatable {
  case opened
  case safari(URL)
  case nowhere
}

/// Why a sign-in didn't take.
enum SignInFailure: Error, Equatable {
  /// The board answered that it doesn't take the token.
  case refused
  case unreachable
  /// The Keychain wouldn't keep the token.
  case keychain
}

/// The app's state: whether it is signed in and to which board, the board as last loaded, the sky,
/// which tab is open, and Chat's history. A fresh start opens the society's general channel; coming back from
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
  let sky = SkyStore()
  /// The images messages show, uploaded ones kept by id for as long as the sign-in lasts.
  private(set) var images = BoardImages()
  /// The image open in the viewer, which Chat presents, outside the lazy rows of a conversation.
  var viewing: ViewedImage?

  @ObservationIgnored let environment: AppEnvironment
  @ObservationIgnored private var client: BoardClient?
  /// Counts sign-ins and sign-outs, so what comes back for an earlier sign-in changes nothing: a
  /// refusal of its token ends no other, and its answers are dropped.
  @ObservationIgnored private(set) var generation = 0
  /// Each conversation's messages as last loaded, kept while the app is signed in.
  @ObservationIgnored private var feeds: [Conversation: ConversationFeed] = [:]
  /// Each message's markdown as last read, with the text and the ids it was read with.
  @ObservationIgnored private var documents:
    [String: (body: String, entities: [String: EntityTitle], document: MessageDocument)] = [:]

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
      if sent == generation {
        endSignIn()
      }
      throw error
    }
  }

  /// An uploaded image's bytes, as the signed-in user; a token the board no longer takes ends the
  /// sign-in, as for any other request.
  func imageData(_ id: String) async throws -> Data {
    guard let client else {
      throw CancellationError()
    }
    let sent = generation
    do {
      return try await client.image(id)
    } catch let error as BoardError where error.isUnauthorized {
      if sent == generation {
        endSignIn()
      }
      throw error
    }
  }

  /// The board's events after `since`, from one connection, as the signed-in user; nil when
  /// signed out.
  func events(since: String) -> AsyncThrowingStream<BoardEvent, any Error>? {
    client?.events(since: since)
  }

  /// The live turn stream from the start of the server's buffer; nil when signed out.
  func turns() -> AsyncThrowingStream<LiveTurnEvent, any Error>? {
    client?.turns(since: 0)
  }

  /// Whether a stream's failure ended the sign-in: a token the board no longer takes does, and
  /// the app goes back to sign-in, as for any other request.
  func ended(by error: any Error) -> Bool {
    guard let error = error as? BoardError, error.isUnauthorized else {
      return false
    }
    endSignIn()
    return true
  }

  private func endSignIn() {
    guard phase == .signedIn else {
      return
    }
    if let board {
      try? environment.tokens.delete(for: board)
    }
    leave(notice: AppModel.ended)
  }

  /// Loads the board again: what Board and Needs you show, and who the token signs in as.
  func refresh() async {
    if actor == nil {
      let sent = generation
      let found = try? await send(BoardAPI.me())
      if sent == generation, let found {
        actor = found
      }
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

  /// The project of the conversation Chat shows, which the sky frames and brightens, as the web's
  /// does a project the board has open: a project's channel, or a thread in one, once the thread
  /// or its task is known.
  var skyFocus: String? {
    let channel: String?
    switch history.current {
    case .channel(let ref):
      channel = ref
    case .thread(let id):
      channel =
        feeds[history.current]?.thread?.channel
        ?? store.tasks.first { $0.id == id }.map { "\($0.project)/general" }
    }
    guard let channel, let slash = channel.firstIndex(of: "/") else {
      return nil
    }
    return String(channel[..<slash])
  }

  /// Where a link in a message goes. A task's, a proposal's, or a thread's link, or a message's,
  /// opens it in Chat; a cron's or a file's opens the board's own page for it in Safari, as does an
  /// address on the web; anything else goes nowhere.
  func follow(_ url: URL) -> LinkOutcome {
    guard url.scheme == nil else {
      let scheme = url.scheme?.lowercased() ?? ""
      return ["http", "https", "mailto"].contains(scheme) ? .safari(url) : .nowhere
    }
    let href = url.relativeString
    if let entity = entityOfHref(href) {
      switch entity.kind {
      case .task, .proposal, .thread:
        open(.thread(entity.id))
        return .opened
      case .message:
        open(entity.thread.map(Conversation.thread) ?? .channel(entity.channel ?? "general"))
        return .opened
      case .cron:
        break
      }
    }
    guard href.hasPrefix("/"), let board else {
      return .nowhere
    }
    let base = board.absoluteString.hasSuffix("/")
      ? String(board.absoluteString.dropLast()) : board.absoluteString
    return URL(string: base + href).map(LinkOutcome.safari) ?? .nowhere
  }

  /// A message's markdown, read once for its text and the ids the board names.
  func document(for message: Message) -> MessageDocument {
    let entities = store.entities
    if let kept = documents[message.id], kept.body == message.body, kept.entities == entities {
      return kept.document
    }
    let document = MessageDocument(markdown: message.body, entities: entities)
    documents[message.id] = (message.body, entities, document)
    return document
  }

  /// How the board names an author, as the web's `displayName` does: the user by the GitHub
  /// account signed in, or else as "you".
  func displayName(_ author: String) -> String {
    author == "user" ? (actor?.signIn?.login ?? "you") : author
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
    documents = [:]
    images = BoardImages()
    sky.clear()
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
    documents = [:]
    images = BoardImages()
    viewing = nil
    store.clear()
    sky.clear()
    history = ChatHistory()
    showsSettings = false
    self.notice = notice
    phase = .signedOut
  }
}
