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
  private(set) var actor: BoardActor? {
    didSet { store.userName = actor?.signIn?.login ?? "you" }
  }
  /// Why the app is back at sign-in, when the board ended the sign-in.
  private(set) var notice: String?
  var tab: AppTab = .chat
  /// The projects Board has opened, the last one shown, kept here so a fold keeps Board's place.
  var boardPath: [String] = []
  var showsSettings = false
  private(set) var history = ChatHistory()
  private(set) var memory: ConversationMemory?
  let store = BoardStore()
  let sky = SkyStore()
  /// The images messages show, uploaded ones kept by id for as long as the sign-in lasts.
  private(set) var images = BoardImages()
  /// The image open in the viewer, which the tabs present.
  var viewing: ViewedImage?
  /// The channel whose New thread sheet is open, which the tabs present.
  var startingThread: String?
  /// What each channel's new thread says so far, kept until it opens, so a sheet dismissed or built
  /// again comes back with its text.
  var newThreads: [String: NewThreadDraft] = [:]
  /// The message a link named in each conversation, marked and scrolled to once, as the web marks
  /// the message its address names.
  private(set) var marks: [Conversation: MessageMark] = [:]
  /// The task whose Advance sheet is open, which Chat presents.
  var advancing: String?
  /// What each task's Advance note says so far, kept until the stage is finished or the note is
  /// cancelled, so a sheet dismissed or built again comes back with its text.
  var advanceNotes: [String: String] = [:]
  /// The proposal whose decision sheet is open, and which way it decides, which Chat presents.
  var deciding: Verdict?
  /// What each decision's reason says so far, kept as the notes are.
  var reasons: [Verdict: String] = [:]
  /// The task or the proposal whose plan or charter is open beside its thread, or in a sheet where
  /// there is no room beside it.
  var inspecting: String?
  /// Follows the board's events while the app is in front, and reads again what they touch.
  let live = LiveUpdates()

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

  /// Follows the board's events as the signed-in user, across drops; nil when signed out.
  func eventFollower() -> EventFollower<ContinuousClock>? {
    guard let client else {
      return nil
    }
    return EventFollower(connect: { client.eventConnection(since: $0) })
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

  /// Shows `conversation` in Chat, which Back then leaves for the one shown before, marked and
  /// scrolled to the message `at` names, if any.
  func open(_ conversation: Conversation, at message: String? = nil) {
    marks[conversation] = message.map { MessageMark(id: $0) }
    history.open(conversation)
    tab = .chat
  }

  /// Notes that the conversation has scrolled to its marked message, which a view built again then
  /// leaves where the user scrolled.
  func reachedMark(in conversation: Conversation) {
    marks[conversation]?.reached = true
  }

  /// Posts `body` to `conversation` as the user, then, without waiting, reads the conversation
  /// again, and what waits on the user, which a post answers where it was asked, as the web's
  /// composer does.
  func post(_ body: String, to conversation: Conversation) async throws -> Message {
    let request =
      switch conversation {
      case .channel(let ref): BoardAPI.postMessage(channel: ref, body: body)
      case .thread(let id): BoardAPI.postMessage(thread: id, body: body)
      }
    let message = try await send(request)
    let feed = feed(for: conversation)
    Task {
      await feed.load(using: self)
      await store.reload(["requests"], using: self)
    }
    return message
  }

  /// Opens the thread `channel`'s draft describes, with its first message if it has one, then shows
  /// it in Chat and forgets the draft, as the web's New thread does.
  func openThread(in channel: String) async throws {
    let draft = newThreads[channel] ?? NewThreadDraft()
    let thread = try await send(
      BoardAPI.openThread(
        channel: channel, title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines)))
    let first = draft.body.trimmingCharacters(in: .whitespacesAndNewlines)
    if !first.isEmpty {
      _ = try await send(BoardAPI.postMessage(thread: thread.id, body: first))
    }
    newThreads[channel] = nil
    if startingThread == channel {
      startingThread = nil
    }
    open(.thread(thread.id))
    await store.reload(["threads"], using: self)
  }

  // MARK: Tasks and proposals

  /// What the thread `conversation` is about: a task or a proposal, as the board last gave it.
  func subject(of conversation: Conversation) -> Subject? {
    guard case .thread(let id) = conversation else {
      return nil
    }
    if let task = store.task(id) {
      return .task(task)
    }
    return store.proposal(id).map(Subject.proposal)
  }

  /// Finishes the task's current stage as the user, with the note its sheet holds for the task's
  /// thread, as the web's form at a stage that names the user does; then shows the task as the
  /// board answered, and reads its thread and the board's tasks and questions again. Only a stage
  /// that waits on the user is finished here, though the board takes the user's advance of any.
  func advance(_ id: String) async throws {
    guard let task = store.task(id), stageForYou(task) != nil else {
      throw SubjectRefusal.notYours
    }
    let note = (advanceNotes[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let advanced = try await send(BoardAPI.advanceTask(id, note: note.isEmpty ? nil : note))
    store.replace(advanced)
    advanceNotes[id] = nil
    if advancing == id {
      advancing = nil
    }
    let feed = feed(for: .thread(id))
    Task {
      await feed.load(using: self)
      await store.reload(["tasks", "requests"], using: self)
    }
  }

  /// Approves or rejects the proposal as the user, with the reason its sheet holds, which a
  /// rejection needs, as the web's decision bar does; then reads the proposals and the thread,
  /// which the decision closes, again. Only a proposal that waits on the user is decided here.
  func decide(_ verdict: Verdict) async throws {
    guard let proposal = store.proposal(verdict.proposal), waitingOnYou(proposal) else {
      throw SubjectRefusal.notYours
    }
    let reason = (reasons[verdict] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    switch verdict.choice {
    case .approve:
      _ = try await send(BoardAPI.approve(verdict.proposal, reason: reason.isEmpty ? nil : reason))
    case .reject:
      guard !reason.isEmpty else {
        throw SubjectRefusal.noReason
      }
      _ = try await send(BoardAPI.reject(verdict.proposal, reason: reason))
    }
    for choice in Verdict.Choice.allCases {
      reasons[Verdict(proposal: verdict.proposal, choice: choice)] = nil
    }
    if deciding?.proposal == verdict.proposal {
      deciding = nil
    }
    let feed = feed(for: .thread(verdict.proposal))
    Task {
      await feed.load(using: self)
      await store.reload(["proposals", "threads", "members", "channels"], using: self)
    }
  }

  /// Reads again what `keys` name of what the app has loaded, as the web's `refreshFor` makes each
  /// key's queries stale: the conversation Chat shows, the board's lists, and the sky's while it is
  /// shown; with `everything`, all of it, as after a drop. Another conversation already read is
  /// read again when it is next shown, as the web refetches a stale query once it is used.
  func reread(_ keys: Set<ReadKey>, everything: Bool = false) async {
    func touched(_ name: String, _ id: String? = nil) -> Bool {
      everything
        || keys.contains { key in
          key.first == name && (key.count < 2 || key[1] == nil || id == nil || key[1] == id)
        }
    }
    // A conversation never read yet is read when it is shown. One still on its first load counts as
    // read: an answer the board gave before the event would leave it without what the event says.
    for (conversation, feed) in feeds where feed.state != .idle {
      let stale =
        switch conversation {
        case .channel(let ref): touched("channel", ref)
        case .thread(let id): touched("thread", id)
        }
      guard stale else {
        continue
      }
      feed.markStale()
      if conversation == history.current {
        await feed.load(using: self)
      }
    }
    let lists = BoardStore.lists.filter { touched($0) }
    if everything {
      await store.refresh(using: self)
    } else if !lists.isEmpty {
      await store.reload(lists, using: self)
    }
    for id in store.lookedUpTasks.keys where touched("task", id) {
      await store.lookUpTask(id, using: self)
    }
    for project in store.dashboards.keys where touched("dashboard", project) {
      await store.loadDashboard(project, using: self)
    }
    sky.markStale(SkyStore.reads.filter { touched($0) }, using: self)
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
        open(
          entity.thread.map(Conversation.thread) ?? .channel(entity.channel ?? "general"),
          at: entity.id)
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
    document(id: message.id, markdown: message.body)
  }

  /// Markdown the board keeps under `id`, a message's, a task's brief, or a dashboard, read as a
  /// message is, once for its text and the ids the board names.
  func document(id: String, markdown: String) -> MessageDocument {
    let entities = store.entities
    if let kept = documents[id], kept.body == markdown, kept.entities == entities {
      return kept.document
    }
    let document = MessageDocument(markdown: markdown, entities: entities)
    documents[id] = (markdown, entities, document)
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
      // A proposal's thread is titled as the board announced it, which the web titles the proposal.
      if let proposal = store.proposal(id) {
        return proposal.title
      }
      if let thread = feeds[conversation]?.thread {
        return thread.title
      }
      return store.task(id)?.title ?? "the thread"
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
    boardPath = []
    marks = [:]
    newThreads = [:]
    forgetSubjects()
    live.clear()
    feeds = [:]
    documents = [:]
    images = BoardImages()
    sky.clear()
    tab = .chat
    notice = nil
    phase = .signedIn
    Task { await store.refresh(using: self) }
  }

  /// Closes the sheets and the inspector of tasks and proposals, and drops what they said.
  private func forgetSubjects() {
    advancing = nil
    advanceNotes = [:]
    deciding = nil
    reasons = [:]
    inspecting = nil
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
    startingThread = nil
    newThreads = [:]
    forgetSubjects()
    marks = [:]
    live.clear()
    store.clear()
    sky.clear()
    history = ChatHistory()
    boardPath = []
    showsSettings = false
    self.notice = notice
    phase = .signedOut
  }
}
