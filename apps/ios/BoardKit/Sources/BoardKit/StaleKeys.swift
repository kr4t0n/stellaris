/// A cached read, as the web names its query: the read's name, then the id or scope it is for,
/// where nil stands for every read of that name.
public typealias ReadKey = [String?]

/// The cached reads an event makes stale, a port of the web's `staleKeys` in
/// `apps/web/src/lib/events.ts`. Both run the case table in `apps/ios/fixtures/cases`.
public func staleKeys(for event: BoardEvent) -> [ReadKey] {
  let type = event.type
  let payload = event.payload
  func text(_ key: String) -> String? { payload[key]?.string }

  if type == "message.posted" {
    guard let thread = text("thread") else {
      return [["channels"], ["channel", text("channel")], ["requests"]]
    }
    return [["threads"], ["thread", thread], ["requests"]]
  }
  if type.hasPrefix("thread.") {
    return [["threads"], ["thread", text("threadId")], ["channel"], ["requests"]]
  }
  if type.hasPrefix("task.") || type.hasPrefix("merge.") || type.hasPrefix("pull_request.")
    || type == "lease.expired"
  {
    let keys: [ReadKey] = [["tasks"], ["task", text("taskId")], ["members"], ["metrics"]]
    // A landing moves the project's default branch.
    return type == "merge.completed" ? keys + [["project-file", text("project")]] : keys
  }
  if type == "turn.completed" || type == "turn.failed" {
    let actor = event.actor
    return [
      ["scheduler"], ["members"], ["turns", actor], ["memory", actor], ["agent-skills", actor],
      ["conflicts", actor], ["history", actor], ["task-file"], ["task-changes"], ["task-diff"],
      ["project-file"], ["metrics"], ["tokens"], ["crons"],
    ]
  }
  if type == "turn.started" {
    return [["scheduler"], ["members"], ["metrics"]]
  }
  if type.hasPrefix("turn.") || type == "wake.requested" || type == "paused.changed" {
    return [["scheduler"], ["members"]]
  }
  if type == "knowledge.written" || type == "knowledge.removed" {
    return [["knowledge", text("project") ?? "society"]]
  }
  if type == "dashboard.updated" {
    return [["dashboard", text("project")]]
  }
  if type.hasPrefix("cron.") {
    return [["crons"]]
  }
  if type == "society.configured" {
    return [["society"], ["crons"]]
  }
  if type.hasPrefix("agent.") || type == "subscription.changed" {
    return [["members"], ["crons"]]
  }
  if type.hasPrefix("project.") || type == "channel.added" || type == "channel.archived" {
    return [["projects"], ["channels"], ["society"], ["crons"]]
  }
  if type == "role.added" {
    return [["roles"]]
  }
  if type == "runner.quota" {
    return [["runners"]]
  }
  if type.hasPrefix("runner.") {
    return [["runners"], ["models"], ["server-version"]]
  }
  if type.hasPrefix("proposal.") {
    return [["proposals"], ["proposal", text("proposalId")], ["metrics"]]
  }
  if type == "skill.promoted" || type == "skill.removed" {
    return [["skills"]]
  }
  if type == "ops.signal" {
    return [["signals"], ["scheduler"], ["metrics"]]
  }
  return []
}
