// Where everything in the sky sits, a port of the web's `skyModel`, `markLabel` and `starOf` in
// `apps/web/src/sky/model.ts`, with the session keys and task rules they read from
// `packages/shared` and `apps/web/src/board/tasks.ts`. Both run the tables in
// `apps/ios/fixtures/sky`, which the web's tests write. Each sum keeps the web's order of
// operations, so the two agree to the last bit wherever the platforms' sines and cosines do.

import Foundation

/// The society's scope, at the center of the sky.
public let societyScope = "society"

/// A place citizens gather: the society at the center, or a project on a ring around it.
public struct SkyAnchor: Sendable, Hashable, Identifiable {
  public enum Kind: String, Sendable, Hashable {
    case society, project
  }

  /// A project's slug, or the society's scope.
  public let id: String
  public let label: String
  public let kind: Kind
  public let x: Double
  public let y: Double
  /// The sphere's radius: everyone who may gather there, and their names, fit inside.
  public let radius: Double
}

/// A citizen's star, at the core or at a project it is in a turn at.
public struct SkyStar: Sendable, Hashable, Identifiable {
  public enum State: String, Sendable, Hashable {
    case idle, queued, working
  }

  /// Unique in the sky: the citizen's name for its star at the core, and `name/scope` for a turn
  /// in a project, since a citizen in turns in two projects has a star in each.
  public let id: String
  public let name: String
  public let cli: OrUnknown<CliKind>
  public let state: State
  /// A warm session is held for the citizen.
  public let resident: Bool
  public let anchor: String
  /// Where a queued turn will run; the star waits at the core until it starts.
  public let queuedFor: String?
  public let x: Double
  public let y: Double
}

/// A task in play: a mark orbiting its project's sphere, in its phase's colour.
public struct SkyTaskMark: Sendable, Hashable, Identifiable {
  /// The phases of a task in play, which the web's task views name.
  public enum Phase: String, Sendable, Hashable {
    case returned, waiting, working, landing

    /// The phase's name in the web's task views (`PHASES` in `apps/web/src/board/tasks.ts`).
    public var label: String {
      switch self {
      case .returned: "Sent back"
      case .waiting: "Waiting for a holder"
      case .working: "Being worked"
      case .landing: "Landing"
      }
    }
  }

  /// The task's id.
  public let id: String
  public let title: String
  public let project: String
  public let phase: Phase
  /// The current stage's name, or its id when the plan no longer has it.
  public let stage: String
  /// Who holds the current stage, if anyone does.
  public let holder: String?
  /// Who may take the current stage while nobody holds it, in words.
  public let waitingFor: String?
  /// The holder's star when it is in a turn at the task's project: the link joins the two.
  public let linked: String?
  public let x: Double
  public let y: Double
}

/// Where everything sits, in world units around the origin. The scene eases toward it.
public struct SkyModel: Sendable, Hashable {
  public let anchors: [SkyAnchor]
  public let stars: [SkyStar]
  public let tasks: [SkyTaskMark]
  /// Every sphere and its name fits in this radius around the origin.
  public let radius: Double
}

/// What the sky is drawn from: the roster, the projects, the scheduler, and every project's tasks.
public struct SkySnapshot: Sendable, Hashable {
  public var members: [Member]
  public var projects: [Project]
  public var scheduler: SchedulerView
  /// Every project's tasks; the ones in play orbit their project.
  public var tasks: [BoardTask]

  public init(
    members: [Member], projects: [Project], scheduler: SchedulerView, tasks: [BoardTask] = []
  ) {
    self.members = members
    self.projects = projects
    self.scheduler = scheduler
    self.tasks = tasks
  }
}

/// The parts of a session key, `agent/scope` and the conversation's part after it, or nil for
/// anything else: a port of `parseSessionKey` in `packages/shared`.
public struct SessionKey: Sendable, Hashable {
  public let agent: String
  public let scope: String
  /// A thread's conversation.
  public let thread: String?
  /// A channel's conversation, from a `#channel` part.
  public let channel: String?
  /// A project's conversation asked from the society scope, from a `~project` part.
  public let place: String?

  public init?(_ key: String) {
    let parts = key.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count >= 2, parts.count <= 3 else { return nil }
    agent = parts[0]
    scope = parts[1]
    let part = parts.count == 3 ? parts[2] : nil
    thread = part.flatMap { $0.hasPrefix("#") || $0.hasPrefix("~") ? nil : $0 }
    channel = part.flatMap { $0.hasPrefix("#") ? String($0.dropFirst()) : nil }
    place = part.flatMap { $0.hasPrefix("~") ? String($0.dropFirst()) : nil }
  }
}

/// Who may hold a stage, in words: a named citizen, any member of a role, or anyone. A port of
/// `assigneeOf` in `apps/web/src/board/tasks.ts`.
public func assignee(of stage: Stage) -> String {
  if let agent = stage.agent {
    return agent
  }
  return stage.role.map { "any \($0)" } ?? "anyone in the project"
}

/// A task mark in words, for the sky's accessibility elements: its stage, its phase, and who holds
/// it, with the link when the holder is in a turn there, or who may take it.
public func markLabel(_ mark: SkyTaskMark, place: String) -> String {
  let who: String? =
    if let holder = mark.holder {
      "held by \(holder)\(mark.linked == nil ? "" : ", in a turn there")"
    } else {
      mark.waitingFor.map { "for \($0)" }
    }
  return ["Task \(mark.title) at \(place)", "stage \(mark.stage)", mark.phase.label.lowercased(), who]
    .compactMap { $0 }
    .joined(separator: ", ")
}

/// The star a live event belongs to: the citizen's star at the event's scope when it is in a turn
/// there, else its only star. The stream names a scope the sky may not have caught up with yet.
public func starOf(_ model: SkyModel, agent: String, scope: String) -> String? {
  let stars = model.stars.filter { $0.name == agent }
  return (stars.first { $0.anchor == scope } ?? stars.first)?.id
}

private let goldenAngle = Double.pi * (3 - 5.0.squareRoot())
private let starSpacing = 68.0
/// Room inside a sphere beyond its outermost star: the star itself and its name below it.
private let spherePad = 44.0
private let sphereMin = 58.0
/// Room outside a sphere for the project's name under it, which also holds the task orbit.
private let nameRoom = 26.0
/// How far outside its sphere a project's tasks orbit.
private let taskOrbit = 13.0
/// The angle between neighbouring tasks on the orbit.
private let taskStep = 0.3
/// Tasks fill the orbit from the top down both sides and stop short of the name at the bottom.
private let taskArc = 1.5 * Double.pi
/// The least space between two spheres, or a sphere and the core.
private let gap = 28.0
private let ringMin = 280.0
/// Projects on the innermost ring; each ring further out holds four more.
private let firstRing = 8
private let margin = 40.0

/// Whether `a` sorts before `b` as the web sorts the board's names, slugs, ids and times: by their
/// UTF-16 code units (`byCodeUnits` in the web's model), the same in every locale. Swift's other
/// orders differ: a numeric or a locale-aware compare puts `p9` before `p10`, and a Danish locale
/// puts `aarhus` after `zed`. On the characters those strings hold, code units give the order the
/// web's `localeCompare` gave in English.
func sortsBefore(_ a: String, _ b: String) -> Bool {
  a.utf16.lexicographicallyPrecedes(b.utf16)
}

/// Rounded as JavaScript's `Math.round` rounds, a half toward positive infinity, where Swift's
/// `rounded()` takes a half away from zero.
func roundedAsJavaScript(_ value: Double) -> Double {
  let floor = value.rounded(.down)
  return value - floor >= 0.5 ? floor + 1 : floor
}

private func sphereRadius(_ citizens: Int) -> Double {
  max(sphereMin, starSpacing * Double(max(0, citizens - 1)).squareRoot() + spherePad)
}

/// The space a sphere claims from its center: the sphere and the name beneath it.
private func footprint(_ radius: Double) -> Double {
  radius + nameRoom
}

/// Each citizen's scopes with a session listed: one star per scope, however many conversations
/// run there, in the order of the sorted keys.
private func scopesByAgent(_ keys: [String]) -> [String: [String]] {
  var scopes: [String: [String]] = [:]
  for key in keys.sorted(by: sortsBefore) {
    guard let parsed = SessionKey(key) else { continue }
    if !(scopes[parsed.agent] ?? []).contains(parsed.scope) {
      scopes[parsed.agent, default: []].append(parsed.scope)
    }
  }
  return scopes
}

/// The phase a task's mark shows, or nil for a task out of play or of a status this client
/// doesn't know, which the sky leaves out.
private func markPhase(of task: BoardTask) -> SkyTaskMark.Phase? {
  switch TaskPhase(of: task) {
  case .returned: .returned
  case .waiting: .waiting
  case .working: .working
  case .landing: .landing
  case .done, .abandoned, .unknown: nil
  }
}

private struct Placement {
  let id: String
  let member: Member
  let cli: OrUnknown<CliKind>
  let state: SkyStar.State
  let scope: String
  let queuedFor: String?
}

/// The sky for a snapshot of the board. Projects sit on rings in creation order around the
/// society at the center. A star away from the core is a turn in progress: a citizen has one star
/// in each project it is in a turn at, and rests at the core otherwise, queued or idle. Spheres
/// are sized for everyone who may gather there and every citizen keeps its seat in each, so a turn
/// starting moves one star and nothing else. Pure, so the same board always draws the same sky.
public func skyModel(_ snapshot: SkySnapshot) -> SkyModel {
  // An archived project has no members and takes no work, so it has no sphere.
  let projects = snapshot.projects
    .filter { $0.archived == nil }
    .sorted { a, b in
      a.createdAt == b.createdAt ? sortsBefore(a.slug, b.slug) : sortsBefore(a.createdAt, b.createdAt)
    }
  let slugs = Set(projects.map(\.slug))
  let placeOf = { (scope: String) in slugs.contains(scope) ? scope : societyScope }

  let running = scopesByAgent(snapshot.scheduler.running)
  let pending = scopesByAgent(snapshot.scheduler.pending)
  let resident = Set(snapshot.scheduler.resident.map { String($0.prefix { $0 != "/" }) })
  let citizens = snapshot.members
    .compactMap { member in member.cli.map { (member: member, cli: $0) } }
    .filter { $0.member.status == .known(.active) }
    .sorted { sortsBefore($0.member.name, $1.member.name) }

  let placements = citizens.flatMap { member, cli -> [Placement] in
    var turns: [String] = []
    for scope in (running[member.name] ?? []).map(placeOf) where !turns.contains(scope) {
      turns.append(scope)
    }
    if !turns.isEmpty {
      return turns.map { scope in
        Placement(
          id: scope == societyScope ? member.name : "\(member.name)/\(scope)",
          member: member, cli: cli, state: .working, scope: scope, queuedFor: nil)
      }
    }
    let queued = pending[member.name]?.first
    return [
      Placement(
        id: member.name, member: member, cli: cli, state: queued == nil ? .idle : .queued,
        scope: societyScope, queuedFor: queued.map(placeOf))
    ]
  }

  // Every citizen has a seat at the core and each member one at its project, in name order, with
  // visiting non-members after them; a star leaving empties its seat and moves nobody else.
  var seats: [String: [String: Int]] = [
    societyScope: Dictionary(
      citizens.enumerated().map { ($1.member.name, $0) }, uniquingKeysWith: { $1 })
  ]
  for project in projects {
    let members = citizens.map(\.member).filter { $0.memberships.contains(project.slug) }
    let visitors = placements
      .filter { $0.scope == project.slug }
      .map(\.member)
      .filter { !$0.memberships.contains(project.slug) }
    seats[project.slug] = Dictionary(
      (members + visitors).enumerated().map { ($1.name, $0) }, uniquingKeysWith: { $1 })
  }
  let room = seats.mapValues(\.count)

  let society = SkyAnchor(
    id: societyScope, label: "society", kind: .society, x: 0, y: 0,
    radius: sphereRadius(room[societyScope] ?? 0))
  let anchors = [society] + placeProjects(projects, room: room, society: society)
  let byId = Dictionary(anchors.map { ($0.id, $0) }, uniquingKeysWith: { $1 })

  let stars = placements.map { placement -> SkyStar in
    let anchor = byId[placement.scope] ?? society
    let slot = seats[anchor.id]?[placement.member.name] ?? 0
    // Sunflower packing: the first seat at the center, the rest spiralling out without overlap.
    let distance = starSpacing * Double(slot).squareRoot()
    let angle = Double(slot) * goldenAngle - Double.pi / 2
    return SkyStar(
      id: placement.id, name: placement.member.name, cli: placement.cli, state: placement.state,
      resident: resident.contains(placement.member.name), anchor: anchor.id,
      queuedFor: placement.queuedFor,
      x: roundedAsJavaScript(anchor.x + distance * cos(angle)),
      y: roundedAsJavaScript(anchor.y + distance * sin(angle)))
  }

  let tasks = placeTasks(snapshot.tasks, anchors: anchors, stars: stars)
  let radius = anchors.map { hypot($0.x, $0.y) + footprint($0.radius) }.max() ?? 0
  return SkyModel(
    anchors: anchors, stars: stars, tasks: tasks, radius: roundedAsJavaScript(radius + margin))
}

/// A project's tasks in play on an orbit just outside its sphere, oldest first: the first at the
/// top, the next ones alternating right and left of it, so a new task takes the next place and none
/// moves. The orbit tightens when a project has more tasks than fit the arc.
private func placeTasks(_ tasks: [BoardTask], anchors: [SkyAnchor], stars: [SkyStar])
  -> [SkyTaskMark]
{
  var marks: [SkyTaskMark] = []
  for anchor in anchors where anchor.kind == .project {
    let inPlay = tasks
      .filter { $0.project == anchor.id }
      .compactMap { task in markPhase(of: task).map { (task: task, phase: $0) } }
      .sorted { sortsBefore($0.task.id, $1.task.id) }
    let step = min(taskStep, taskArc / Double(max(1, inPlay.count)))
    let orbit = anchor.radius + taskOrbit
    for (index, (task, phase)) in inPlay.enumerated() {
      let side = index % 2 == 0 ? 1.0 : -1.0
      let angle = -Double.pi / 2 + side * Double((index + 1) / 2) * step
      let holder = phase == .landing ? nil : task.claimedBy
      let stage = task.stages.first { $0.id == task.stage }
      let linked = holder.flatMap { holder in
        stars.first { $0.name == holder && $0.anchor == anchor.id }?.id
      }
      marks.append(
        SkyTaskMark(
          id: task.id, title: task.title, project: anchor.id, phase: phase,
          stage: stage?.name ?? task.stage, holder: holder,
          waitingFor: holder == nil && phase != .landing ? stage.map(assignee(of:)) : nil,
          linked: linked,
          x: roundedAsJavaScript(anchor.x + orbit * cos(angle)),
          y: roundedAsJavaScript(anchor.y + orbit * sin(angle))))
    }
  }
  return marks
}

/// Projects on rings around the core, the first ring holding eight and each further one four more.
/// On a ring every project gets a slice of the circle as wide as its sphere, the first slice
/// centered at the top, and the ring is pushed out until neighbouring spheres, the core, and the
/// ring inside all clear each other.
private func placeProjects(_ projects: [Project], room: [String: Int], society: SkyAnchor)
  -> [SkyAnchor]
{
  var placed: [SkyAnchor] = []
  var reach = footprint(society.radius)
  var capacity = firstRing
  var start = 0
  var ring = 0
  while start < projects.count {
    let members = Array(projects[start..<min(projects.count, start + capacity)])
    start += capacity
    capacity += 4
    let radii = members.map { sphereRadius(room[$0.slug] ?? 0) }
    let feet = radii.map(footprint)
    let widths = feet.map { 2 * $0 + gap }
    let total = widths.reduce(0, +)
    let slices = widths.map { (2 * Double.pi * $0) / total }
    // Rings further out start half a slice later, so their spheres sit between the inner ones.
    var edge = -Double.pi / 2 - slices[0] / 2 + (ring == 0 ? 0 : Double.pi / Double(members.count))
    let angles = slices.map { slice -> Double in
      let center = edge + slice / 2
      edge += slice
      return center
    }
    let widest = feet.max() ?? 0
    var distance = max(ring == 0 ? ringMin : 0, reach + widest + gap)
    if members.count > 1 {
      for i in members.indices {
        let j = (i + 1) % members.count
        let apart = (slices[i] + slices[j]) / 2
        let needed = (feet[i] + feet[j] + gap) / (2 * sin(apart / 2))
        distance = max(distance, needed)
      }
    }
    for (index, project) in members.enumerated() {
      placed.append(
        SkyAnchor(
          id: project.slug, label: project.name, kind: .project,
          x: roundedAsJavaScript(distance * cos(angles[index])),
          y: roundedAsJavaScript(distance * sin(angles[index])),
          radius: roundedAsJavaScript(radii[index])))
    }
    reach = distance + widest
    ring += 1
  }
  return placed
}
