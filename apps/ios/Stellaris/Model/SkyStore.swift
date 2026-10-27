import BoardKit
import Foundation
import Observation

/// The sky as the app keeps it: the roster and the scheduler it is drawn from, beside the board
/// store's projects and tasks; its motion; and what the user did to it, the camera and the open
/// card. It lives in the app's model, not in the view, so a fold or a rotation that builds the
/// view again keeps every star where it was and the camera where the user left it.
@MainActor @Observable final class SkyStore {
  /// The camera as VoiceOver and the Fit button describe it: published when a gesture moves it,
  /// and when the motion turns to a new target, not at every frame.
  struct Camera: Equatable {
    var mode = SkyCameraMotion.Mode.home
    var target = SkyCamera(x: 0, y: 0, scale: 1)
    /// The home view's scale on the sky's last viewport, which a zoom is a percentage of.
    var homeScale = 1.0
    /// The project framed, in focus mode.
    var focus: String?
  }

  private(set) var state: Loading = .idle
  private(set) var members: [Member] = []
  private(set) var scheduler: SchedulerView?
  /// The card open at the foot of the sky.
  var card: SkyTarget?
  private(set) var camera = Camera()
  /// The line each citizen posted last while the sky was shown, by name, for VoiceOver.
  private(set) var lastSaid: [String: String] = [:]

  /// The motion, which every frame steps; changing it publishes nothing.
  @ObservationIgnored var scene = SkyScene()
  /// The viewport the last frame was drawn in, which gestures between frames work in.
  @ObservationIgnored var viewport = SkyViewport(width: 0, height: 0)
  /// The last frame drawn, where a touch finds what it took.
  @ObservationIgnored var lastFrame: SkyFrame?
  /// The clock the turn stream's events are measured against.
  @ObservationIgnored var now: @MainActor () -> Date = Date.init
  /// Reads an event made stale, gathered while a reload waits.
  @ObservationIgnored private var stale: Set<String> = []
  @ObservationIgnored private var reloading: Task<Void, Never>?
  /// The last event the board's stream gave, which a reconnect asks after.
  @ObservationIgnored private var lastEvent: String?

  /// The reads the sky is drawn from, as the web's queries name them (`staleKeys`).
  static let reads: Set<String> = ["members", "scheduler", "projects", "tasks"]

  /// The sky for the board as last loaded.
  func model(projects: [Project], tasks: [BoardTask]) -> SkyModel {
    skyModel(
      SkySnapshot(
        members: members, projects: projects,
        scheduler: scheduler ?? SchedulerView(paused: false, running: [], pending: [], resident: []),
        tasks: tasks))
  }

  /// Shows a board as it stands, for the snapshots.
  func show(members: [Member], scheduler: SchedulerView) {
    self.members = members
    self.scheduler = scheduler
    state = .loaded
  }

  // MARK: The camera

  /// Zooms by `factor` around a point, the middle of the free sky by default.
  func zoom(by factor: Double, at point: SkyPoint? = nil) {
    scene.zoom(by: factor, at: point, in: viewport)
    publishCamera()
  }

  /// Follows a drag of `dx`, `dy` points.
  func pan(dx: Double, dy: Double) {
    scene.pan(dx: dx, dy: dy)
    publishCamera()
  }

  /// Back to the whole sky.
  func home() {
    scene.home()
    scene.step(at: scene.clock, in: viewport)
    publishCamera()
  }

  /// Publishes the camera when the motion has turned to a new target or mode.
  func publishCamera() {
    let current = Camera(
      mode: scene.camera.mode, target: scene.camera.target,
      homeScale: homeCamera(viewport, radius: scene.model?.radius ?? 1).scale,
      focus: scene.camera.mode == .focus ? scene.camera.focus : nil)
    if current != camera {
      camera = current
    }
  }

  /// The card for what a touch at `point` took on the last frame, or none for empty sky.
  func tap(at point: SkyPoint) {
    card = lastFrame?.hit(at: point)
  }

  // MARK: Loading and following the board

  /// Loads the sky, then follows the board's events and the live turn stream until cancelled, as
  /// the sky's view does while it is shown.
  func run(using model: AppModel) async {
    await load(using: model)
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.follow(using: model) }
      group.addTask { await self.listen(using: model) }
    }
  }

  /// Loads the roster and the scheduler; the board store holds the projects and tasks.
  func load(using model: AppModel) async {
    let signIn = model.generation
    if state != .loaded {
      state = .loading
    }
    do {
      async let members = model.send(BoardAPI.members())
      async let scheduler = model.send(BoardAPI.scheduler())
      let loaded = try await (members, scheduler)
      guard model.generation == signIn else {
        return
      }
      self.members = loaded.0
      self.scheduler = loaded.1
      state = .loaded
    } catch is CancellationError {
      return
    } catch {
      if model.generation == signIn, state != .loaded {
        state = Loading(error)
      }
    }
  }

  /// Follows the board's events, reloading what each makes stale of what the sky is drawn from,
  /// and after a drop picks up from the last event it had, so nothing is missed.
  private func follow(using model: AppModel) async {
    var wait = 1.0
    while !Task.isCancelled {
      let since = lastEvent ?? "latest"
      guard let events = model.events(since: since) else {
        return
      }
      do {
        for try await event in events {
          wait = 1
          lastEvent = event.id
          let names = Set(staleKeys(for: event).compactMap { $0.first ?? nil })
          markStale(names.intersection(SkyStore.reads), using: model)
        }
      } catch {
        if model.ended(by: error) {
          return
        }
      }
      try? await Task.sleep(for: .seconds(wait))
      wait = min(wait * 2, 30)
    }
  }

  /// Listens to the live turn stream: a tool's call flickers its citizen's star, and a post's first
  /// line rises from it. Each connection replays the server's short buffer first, which
  /// `skyCue` leaves be once older than fifteen seconds.
  private func listen(using model: AppModel) async {
    var wait = 1.0
    while !Task.isCancelled {
      guard let turns = model.turns() else {
        return
      }
      do {
        for try await item in turns {
          wait = 1
          guard case .toolCall = item.event else {
            continue
          }
          let sky = self.model(projects: model.store.projects, tasks: model.store.tasks)
          guard let cue = skyCue(for: item, in: sky, now: now()) else {
            continue
          }
          let line = cue.line.map { model.store.withTaskTitles($0) }
          scene.play(SkyCue(star: cue.star, line: line))
          if let line, let name = sky.stars.first(where: { $0.id == cue.star })?.name {
            lastSaid[name] = line
          }
        }
      } catch {
        if model.ended(by: error) {
          return
        }
      }
      try? await Task.sleep(for: .seconds(wait))
      wait = min(wait * 2, 30)
    }
  }

  /// Gathers the reads an event made stale and reloads them a moment later, once for a burst.
  private func markStale(_ names: Set<String>, using model: AppModel) {
    guard !names.isEmpty else {
      return
    }
    stale.formUnion(names)
    guard reloading == nil else {
      return
    }
    reloading = Task {
      try? await Task.sleep(for: .milliseconds(250))
      while !stale.isEmpty {
        let names = stale
        stale = []
        await reload(names, using: model)
      }
      reloading = nil
    }
  }

  private func reload(_ names: Set<String>, using model: AppModel) async {
    let signIn = model.generation
    if names.contains("members"), let members = try? await model.send(BoardAPI.members()),
      model.generation == signIn
    {
      self.members = members
    }
    if names.contains("scheduler"), let scheduler = try? await model.send(BoardAPI.scheduler()),
      model.generation == signIn
    {
      self.scheduler = scheduler
    }
    if names.contains("projects") || names.contains("tasks") {
      await model.store.reloadProjects(using: model)
    }
  }

  func clear() {
    reloading?.cancel()
    reloading = nil
    stale = []
    lastEvent = nil
    state = .idle
    members = []
    scheduler = nil
    card = nil
    camera = Camera()
    lastSaid = [:]
    scene = SkyScene()
    lastFrame = nil
  }
}
