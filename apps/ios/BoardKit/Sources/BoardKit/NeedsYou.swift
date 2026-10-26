// What waits on the user, a port of the web's `needsYou` in `apps/web/src/board/governance.ts`
// and the rules it reads from `packages/shared`. Both run the case table in
// `apps/ios/fixtures/cases`.

/// The user's name and role on every board.
public let userName = "user"
public let userRole = "user"

/// Something that waits on the user, and since when.
public enum Attention: Sendable, Hashable {
  case proposal(Proposal, since: String)
  case stage(BoardTask, Stage, since: String)
  /// A question asked of the user, in the thread it was asked in or nil for a channel post.
  case request(Message, thread: BoardThread?, since: String)

  public var since: String {
    switch self {
    case .proposal(_, let since), .stage(_, _, let since), .request(_, _, let since): since
    }
  }
}

/// Where a task stands, as the task views group it.
public enum TaskPhase: Sendable, Hashable {
  case returned, waiting, working, landing, done, abandoned

  public init(of task: BoardTask) {
    switch task.status {
    case .done: self = .done
    case .abandoned: self = .abandoned
    case .open, .claimed:
      if task.completing {
        self = .landing
      } else if task.returned != nil {
        self = .returned
      } else {
        self = task.status == .claimed ? .working : .waiting
      }
    }
  }
}

/// The roles that may decide a proposal: its kind's, narrowed to the user for a reallocation that
/// changes a role's verbs or replica cap. The board checked the charter when it was filed.
public func proposalApprovers(_ proposal: Proposal) -> [String] {
  if proposal.kind == .reallocation, let changes = proposal.charter["changes"],
    ["verbs", "maxReplicas"].contains(where: { changes[$0] != nil && changes[$0] != .null })
  {
    return [userRole]
  }
  switch proposal.kind {
  case .role, .member, .retirement, .archive: return [userRole]
  case .channel, .reallocation, .skill: return [userRole, "steward"]
  }
}

/// Whether the user may decide the proposal now. A proposer never decides its own.
public func waitingOnYou(_ proposal: Proposal) -> Bool {
  proposal.status == .proposed && proposal.proposedBy != userName
    && proposalApprovers(proposal).contains(userRole)
}

/// The task's current stage when it waits on the user: named for the user, and nobody else holds
/// it.
public func stageForYou(_ task: BoardTask) -> Stage? {
  switch TaskPhase(of: task) {
  case .landing, .done, .abandoned: return nil
  case .returned, .waiting, .working: break
  }
  guard let stage = task.stages.first(where: { $0.id == task.stage }),
    stage.agent == userName || stage.role == userRole
  else {
    return nil
  }
  return task.status == .open || task.claimedBy == userName ? stage : nil
}

/// What waits on the user: proposals the user may decide, then stages named for the user, then
/// questions the user has not answered, each group oldest first.
public func needsYou(
  proposals: [Proposal], tasks: [BoardTask], requests: [UserRequest]
) -> [Attention] {
  let waiting = proposals.filter(waitingOnYou).map { Attention.proposal($0, since: $0.createdAt) }
  let stages = tasks.compactMap { task in
    stageForYou(task).map { Attention.stage(task, $0, since: task.stageSince) }
  }
  let questions = requests.map {
    Attention.request($0.message, thread: $0.thread, since: $0.message.ts)
  }
  return oldestFirst(waiting) + oldestFirst(stages) + oldestFirst(questions)
}

/// Sorted by when each began, keeping the given order among equals, as the web's `toSorted` does.
private func oldestFirst(_ items: [Attention]) -> [Attention] {
  items.enumerated()
    .sorted { ($0.element.since, $0.offset) < ($1.element.since, $1.offset) }
    .map(\.element)
}
