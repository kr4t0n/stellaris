import BoardKit
import Foundation
import Observation

/// Whether something the app shows has loaded.
enum Loading: Equatable, Sendable {
  case idle, loading, loaded
  /// The board couldn't be reached, or refused with this message.
  case failed(String)

  init(_ error: any Error) {
    if let error = error as? BoardError, error.status != 0 {
      self = .failed(error.message)
    } else {
      self = .failed(Loading.unreachable)
    }
  }

  static let unreachable = "Can't reach the board"
}

/// The board as Board and Needs you show it, loaded when the app signs in, comes back to the
/// foreground, or is pulled to refresh.
@MainActor @Observable final class BoardStore {
  private(set) var state: Loading = .idle
  private(set) var channels: [ChannelSummary] = []
  private(set) var projects: [Project] = []
  /// Every project's tasks.
  private(set) var tasks: [BoardTask] = [] {
    didSet { index() }
  }
  private(set) var proposals: [Proposal] = [] {
    didSet { index() }
  }
  private(set) var requests: [UserRequest] = []
  /// The roster, for each author's CLI mark.
  private(set) var members: [Member] = []
  /// Every thread, for the titles its id reads as.
  private(set) var threads: [ThreadSummary] = [] {
    didSet { index() }
  }
  /// The messages the board's text has named by id so far, as the board looked them up.
  private(set) var messageRefs: [MessageRef] = [] {
    didSet { index() }
  }
  /// How the user's own posts are named: the GitHub account signed in, or else "you".
  var userName = "you" {
    didSet { index() }
  }
  /// What each id in the board's text names, as the web's `entityIndex` reads them: a message as
  /// whose post it is and where, a thread by its title, as its subject for a task's or a
  /// proposal's, then each task and each proposal, each later one winning.
  private(set) var entities: [String: EntityTitle] = [:]
  /// The ids asked about, each once, since a message never moves once posted.
  @ObservationIgnored private var asked: Set<String> = []

  /// What waits on the user, as the web's Needs you lists it.
  var attention: [Attention] {
    needsYou(proposals: proposals, tasks: tasks, requests: requests)
  }

  /// The society's channels that take posts.
  var societyChannels: [ChannelSummary] {
    channels.filter { $0.project == nil && $0.archived == nil }
  }

  /// The projects not archived.
  var openProjects: [Project] {
    projects.filter { $0.archived == nil }
  }

  func channels(of project: String) -> [ChannelSummary] {
    channels.filter { $0.project == project && $0.archived == nil }
  }

  /// A project's tasks still in play, oldest first.
  func tasksInPlay(of project: String) -> [BoardTask] {
    tasks.filter { task in
      guard task.project == project else {
        return false
      }
      switch TaskPhase(of: task) {
      case .done, .abandoned: return false
      case .returned, .waiting, .working, .landing, .unknown: return true
      }
    }
  }

  /// A line with each id the board names read as its title, for a place that can't hold a link.
  func titled(_ line: String) -> String {
    splitEntities(line, index: entities).map { piece in
      switch piece {
      case .text(let text): text
      case .entity(_, let entity): entity.title
      }
    }.joined()
  }

  /// The CLI `author` runs on; nil for the user, the board, or a name the roster doesn't have.
  func cli(of author: String) -> OrUnknown<CliKind>? {
    members.first { $0.name == author }?.cli
  }

  /// Looks up, as the web's `MessageLookup` does, the ids `texts` name that nothing names yet,
  /// which may name messages. An id is asked about once; one that names no message, or whose
  /// lookup failed, stays as written.
  func lookUpMessages(in texts: [String], using model: AppModel) async {
    var ids: [String] = []
    for text in texts {
      for id in unknownIds(text, index: entities) where !asked.contains(id) {
        asked.insert(id)
        ids.append(id)
      }
    }
    let signIn = model.generation
    var found: [MessageRef] = []
    for start in stride(from: 0, to: ids.count, by: BoardAPI.messageLookupLimit) {
      let batch = Array(ids[start..<min(start + BoardAPI.messageLookupLimit, ids.count)])
      if let refs = try? await model.send(BoardAPI.messages(batch)) {
        found += refs
      }
    }
    if !found.isEmpty, model.generation == signIn {
      messageRefs += found
    }
  }

  private func index() {
    let titles = Dictionary(
      threads.map { ($0.thread.id, $0.thread.title) }, uniquingKeysWith: { $1 })
    let user = userName
    var index = messageTitles(
      messageRefs, threadTitles: titles, name: { $0 == "user" ? user : $0 })
    for summary in threads {
      let thread = summary.thread
      let kind: EntityKind =
        switch thread.subject?.kind {
        case .known(.task)?: .task
        case .known(.proposal)?: .proposal
        default: .thread
        }
      index[thread.id] = EntityTitle(kind: kind, title: thread.title)
    }
    for task in tasks {
      index[task.id] = EntityTitle(kind: .task, title: task.title)
    }
    for proposal in proposals {
      index[proposal.id] = EntityTitle(kind: .proposal, title: proposal.title)
    }
    entities = index
  }

  func projectName(_ slug: String) -> String {
    projects.first { $0.slug == slug }?.name ?? slug
  }

  /// A line with each id the board names in it read as its title, as the web's sky reads a post's
  /// line with `withTitles` over the whole index: standing alone, not in a path or a file name,
  /// with a title it echoes said once.
  func withEntityTitles(_ line: String) -> String {
    withTitles(line, index: entities)
  }

  /// The lists `reload` reads again, as the web's queries name them (`staleKeys`).
  static let lists: Set<String> = [
    "channels", "projects", "tasks", "proposals", "requests", "members", "threads",
  ]

  /// Loads again the lists `names` names, as events that touched them ask, leaving the rest of
  /// the board as it was. What comes back once the app has signed out, or in again, is dropped,
  /// and so is a list that fails to load, which stays as it was.
  func reload(_ names: Set<String>, using model: AppModel) async {
    let signIn = model.generation
    func load<Value>(_ name: String, _ request: BoardRequest<Value>) async -> Value? {
      guard names.contains(name), let value = try? await model.send(request),
        model.generation == signIn
      else {
        return nil
      }
      return value
    }
    if let channels = await load("channels", BoardAPI.channels()) {
      self.channels = channels
    }
    if let proposals = await load("proposals", BoardAPI.proposals()) {
      self.proposals = proposals
    }
    if let members = await load("members", BoardAPI.members()) {
      self.members = members
    }
    if let threads = await load("threads", BoardAPI.threads()) {
      self.threads = threads
    }
    if let requests = await load("requests", BoardAPI.requests()) {
      self.requests = requests
      await lookUpMessages(in: requests.map(\.message.body), using: model)
    }
    if !names.isDisjoint(with: ["projects", "tasks"]) {
      await reloadProjects(using: model)
    }
  }

  /// The citizens a mention typed as `prefix` offers, as the web's composer offers them: active
  /// ones with a CLI, in the roster's order, six at most.
  func mentionable(_ prefix: String) -> [Member] {
    Array(
      members.filter { member in
        member.status == .known(.active) && member.cli != nil && member.name.hasPrefix(prefix)
      }
      .prefix(6))
  }

  /// Why `channel` takes no posts, if it doesn't: it was archived, or its project was. The board
  /// refuses posts and threads there.
  func readOnly(_ channel: String) -> ReadOnly? {
    if let archived = channels.first(where: { $0.ref == channel })?.archived {
      return .archived(archived)
    }
    let parts = channel.split(separator: "/")
    if parts.count > 1, let project = projects.first(where: { $0.slug == parts[0] }),
      project.archived != nil
    {
      return .projectArchived(project.name)
    }
    return nil
  }

  /// Why a channel takes no posts.
  enum ReadOnly: Equatable {
    case archived(ArchivedChannel)
    case projectArchived(String)
  }

  /// Loads the projects and their tasks again, as an event that touched them asks, leaving the
  /// rest of the board as it was. What comes back once the app has signed out, or in again, is
  /// dropped, and so is a load that fails: the sky keeps what it had.
  func reloadProjects(using model: AppModel) async {
    let signIn = model.generation
    do {
      let projects = try await model.send(BoardAPI.projects())
      var tasks: [BoardTask] = []
      for project in projects where project.archived == nil {
        tasks += try await model.send(BoardAPI.tasks(project: project.slug))
      }
      guard model.generation == signIn else {
        return
      }
      self.projects = projects
      self.tasks = tasks
    } catch {
      return
    }
  }

  /// Loads the board `model` is signed in to. What comes back once it has signed out, or in again,
  /// is dropped.
  func refresh(using model: AppModel) async {
    let signIn = model.generation
    if state != .loaded {
      state = .loading
    }
    do {
      async let channels = model.send(BoardAPI.channels())
      async let projects = model.send(BoardAPI.projects())
      async let proposals = model.send(BoardAPI.proposals())
      async let requests = model.send(BoardAPI.requests())
      // The roster and the threads only dress what the rest shows, so the board loads without them.
      async let members = try? model.send(BoardAPI.members())
      async let threads = try? model.send(BoardAPI.threads())
      let loaded = try await (channels, projects, proposals, requests)
      let dressing = await (members, threads)
      var tasks: [BoardTask] = []
      for project in loaded.1 where project.archived == nil {
        tasks += try await model.send(BoardAPI.tasks(project: project.slug))
      }
      guard model.generation == signIn else {
        return
      }
      self.channels = loaded.0
      self.projects = loaded.1
      self.proposals = loaded.2
      self.requests = loaded.3
      self.tasks = tasks
      if let members = dressing.0 {
        self.members = members
      }
      if let threads = dressing.1 {
        self.threads = threads
      }
      state = .loaded
      await lookUpMessages(in: loaded.3.map(\.message.body), using: model)
    } catch is CancellationError {
      return
    } catch {
      if model.generation == signIn {
        state = Loading(error)
      }
    }
  }

  /// Shows projects and tasks as they stand, for the sky's snapshots.
  func show(projects: [Project], tasks: [BoardTask]) {
    self.projects = projects
    self.tasks = tasks
    state = .loaded
  }

  func clear() {
    state = .idle
    channels = []
    projects = []
    tasks = []
    proposals = []
    requests = []
    members = []
    threads = []
    messageRefs = []
    asked = []
  }
}

extension Proposal {
  /// What a proposal is called: its kind, and the name its charter gives, as "Member · eng-2".
  var title: String {
    let name = charter["name"]?.string ?? charter["role"]?.string
    return [kind.rawValue.capitalized, name].compactMap { $0 }.joined(separator: " · ")
  }
}

/// A conversation's messages as last loaded, kept by conversation so a view built again shows them
/// at once.
@MainActor @Observable final class ConversationFeed {
  let conversation: Conversation
  private(set) var state: Loading = .idle
  /// The thread itself, for a thread: its title, and the channel Back goes to.
  private(set) var thread: BoardThread?
  private(set) var messages: [Message] = []
  /// Whether an event touched the conversation since it was last read, so it is read again when it
  /// is next shown.
  @ObservationIgnored private(set) var stale = false

  init(conversation: Conversation) {
    self.conversation = conversation
  }

  func markStale() {
    stale = true
  }

  /// Counts loads, so an answer that a later load's overtook changes nothing.
  @ObservationIgnored private var loads = 0

  func load(using model: AppModel) async {
    loads += 1
    let load = loads
    if state != .loaded {
      state = .loading
    }
    do {
      switch conversation {
      case .channel(let ref):
        let messages = try await model.send(BoardAPI.channel(ref))
        guard load == loads else {
          return
        }
        self.messages = messages
      case .thread(let id):
        let detail = try await model.send(BoardAPI.thread(id))
        guard load == loads else {
          return
        }
        thread = detail.thread
        messages = detail.messages
      }
      state = .loaded
      stale = false
      await model.store.lookUpMessages(in: messages.map(\.body), using: model)
    } catch is CancellationError {
      return
    } catch {
      if load == loads, state != .loaded {
        state = Loading(error)
      }
    }
  }
}
