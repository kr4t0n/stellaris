// What the task views say of a task and its plan: ports of `PHASES`, `isCurrent`, `stageName`,
// `stepLabel`, `groupTasks`, and `progressOf` in the web's `apps/web/src/board/tasks.ts`, whose
// tests `TaskPlanTests` repeat; its `assigneeOf` is `assignee(of:)`, which the sky's model ports.

extension TaskPhase {
  /// The phases in the order the task views group them, a status this client doesn't know last.
  public static let listed: [TaskPhase] = [
    .returned, .waiting, .working, .landing, .done, .abandoned, .unknown,
  ]

  /// The phase's name, as the web's `PHASES` labels it.
  public var label: String {
    switch self {
    case .returned: "Sent back"
    case .waiting: "Waiting for a holder"
    case .working: "Being worked"
    case .landing: "Landing"
    case .done: "Done"
    case .abandoned: "Abandoned"
    case .unknown: "Status unknown"
    }
  }
}

extension BoardTask {
  public var phase: TaskPhase { TaskPhase(of: self) }

  /// The stage the task is at now, held or waiting for a holder; nil once it lands, ends, or has a
  /// status this client doesn't know.
  public var currentStage: Stage? {
    switch phase {
    case .landing, .done, .abandoned, .unknown: nil
    case .returned, .waiting, .working: stages.first { $0.id == stage }
    }
  }

  /// Whether `stage` is the one the task is at now.
  public func isCurrent(_ stage: Stage) -> Bool {
    currentStage?.id == stage.id
  }

  /// Who holds the current stage now, if anyone.
  public var holder: String? {
    status == .known(.claimed) ? claimedBy : nil
  }

  /// A stage of the task by its name, or its id when a plan change has removed it.
  public func stageName(_ id: String) -> String {
    stages.first { $0.id == id }?.name ?? id
  }

  /// "Stage 2 of 3", or where the task ended.
  public var progress: String {
    switch phase {
    case .done: return "All \(stages.count) stages done"
    case .abandoned: return "Abandoned"
    default:
      // A stage the plan no longer holds counts as before the first, as `findIndex` gives -1.
      let index = stages.firstIndex { $0.id == stage } ?? -1
      return "Stage \(index + 1) of \(stages.count)"
    }
  }
}

/// A phase's tasks, as the task views list them.
public struct TaskGroup: Sendable, Hashable, Identifiable {
  public let phase: TaskPhase
  public let tasks: [BoardTask]

  public var id: TaskPhase { phase }
}

/// Tasks grouped by phase in the order the task views show them, each group last updated first and
/// otherwise in the order given, leaving out empty groups.
public func groupTasks(_ tasks: [BoardTask]) -> [TaskGroup] {
  TaskPhase.listed.compactMap { phase in
    let members = tasks.enumerated().filter { $0.element.phase == phase }
      .sorted { a, b in
        a.element.updatedAt != b.element.updatedAt
          ? sortsBefore(b.element.updatedAt, a.element.updatedAt) : a.offset < b.offset
      }
      .map(\.element)
    return members.isEmpty ? nil : TaskGroup(phase: phase, tasks: members)
  }
}

/// How a step's chip reads, as its colour: a task finished a stage or a proposal was approved, sent
/// back, abandoned, landed, or failed to land or was rejected.
public enum StepTone: Sendable, Hashable {
  case finished, returned, abandoned, landed, failed
}

/// What a step's chip says on the post that recorded it, naming the stages from `task` when it is
/// at hand and by their ids otherwise; nil for a step of a shape this client doesn't know.
public func stepLabel(_ step: MessageStep, task: BoardTask?) -> (text: String, tone: StepTone)? {
  func name(_ id: String) -> String {
    task?.stageName(id) ?? id
  }
  switch step {
  case .proposal(let decision):
    switch decision.action {
    case .known(.approved): return ("approved", .finished)
    case .known(.rejected): return ("rejected", .failed)
    case .unknown(let action): return (action, .abandoned)
    }
  case .task(let step):
    switch step.action {
    case .known(.advanced):
      let text = step.to.map { "finished \(name(step.stage)) → \(name($0))" }
      return (text ?? "finished \(name(step.stage))", .finished)
    case .known(.returned):
      return ("sent back from \(name(step.stage)) to \(step.to.map(name) ?? "an earlier stage")", .returned)
    case .known(.abandoned):
      return ("abandoned", .abandoned)
    case .known(.landed):
      return ("landed", .landed)
    case .known(.reopened):
      return ("landing failed · back at \(name(step.stage))", .failed)
    case .unknown(let action):
      return (action, .abandoned)
    }
  case .unknown:
    return nil
  }
}
