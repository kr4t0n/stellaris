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
  private(set) var tasks: [BoardTask] = []
  private(set) var proposals: [Proposal] = []
  private(set) var requests: [UserRequest] = []

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

  func projectName(_ slug: String) -> String {
    projects.first { $0.slug == slug }?.name ?? slug
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
      let loaded = try await (channels, projects, proposals, requests)
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
      state = .loaded
    } catch is CancellationError {
      return
    } catch {
      if model.generation == signIn {
        state = Loading(error)
      }
    }
  }

  func clear() {
    state = .idle
    channels = []
    projects = []
    tasks = []
    proposals = []
    requests = []
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

  init(conversation: Conversation) {
    self.conversation = conversation
  }

  func load(using model: AppModel) async {
    if state != .loaded {
      state = .loading
    }
    do {
      switch conversation {
      case .channel(let ref):
        messages = try await model.send(BoardAPI.channel(ref))
      case .thread(let id):
        let detail = try await model.send(BoardAPI.thread(id))
        thread = detail.thread
        messages = detail.messages
      }
      state = .loaded
    } catch is CancellationError {
      return
    } catch {
      state = Loading(error)
    }
  }
}
