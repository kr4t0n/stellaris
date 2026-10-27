import BoardKit
import Foundation

@testable import Stellaris

/// A society busier than the captured one, for the sky's snapshots: three projects, citizens on
/// both CLIs resting, queued, in turns at a project and at the core, a warm session, and tasks in
/// every phase, two of them held by a citizen in a turn on them. Written as the board's answers and
/// decoded with the app's models, so the pictures show what the board would make of it.
enum SkySample {
  static let time = "2026-10-27T09:00:00.000Z"

  static func id(_ number: Int) -> String {
    String(format: "01M5A00000000000000000T%03d", number)
  }

  static var members: [Member] {
    decode([
      member("concierge-1", "concierge", "claude", []),
      member("steward-1", "steward", "claude", []),
      member("eng-1", "engineer", "codex", ["demo", "ops"]),
      member("eng-2", "engineer", "claude", ["demo"]),
      member("rev-1", "reviewer", "claude", ["demo", "docs"]),
      member("writer-1", "writer", "codex", ["docs"]),
      member("ops-1", "operator", "codex", ["ops"]),
      ["name": "user", "role": "user", "cli": NSNull(), "status": "active", "memberships": ["demo"]],
    ])
  }

  static var projects: [Project] {
    decode([project("demo", "Demo", 1), project("docs", "Docs", 2), project("ops", "Ops", 3)])
  }

  static var scheduler: SchedulerView {
    SchedulerView(
      paused: false,
      running: ["eng-1/demo/\(id(1))", "writer-1/docs/\(id(4))", "concierge-1/society"],
      pending: ["rev-1/demo/\(id(2))"], resident: ["concierge-1/society"])
  }

  static var tasks: [BoardTask] {
    decode([
      task(1, "demo", "Add the export view", stage: ("s1", "Build it", nil, "engineer"), holder: "eng-1"),
      task(2, "demo", "Fix the empty state", stage: ("s2", "Review it", nil, "reviewer"), holder: nil),
      task(
        3, "demo", "Retry failed uploads", stage: ("s1", "Build it", nil, "engineer"), holder: "eng-2",
        returned: true),
      task(4, "docs", "Write the release notes", stage: ("s1", "Draft it", "writer-1", nil), holder: "writer-1"),
      task(5, "docs", "Publish the guide", stage: ("s1", "Merge it", nil, nil), holder: nil, completing: true),
      task(6, "ops", "Rotate the runner's token", stage: ("s1", "Approve it", "user", nil), holder: nil),
    ])
  }

  /// Tasks with these ids and titles, each open at a stage of its own.
  static func tasks(titled titles: [String: String]) -> [BoardTask] {
    decode(
      titles.sorted { $0.key < $1.key }.map { id, title in
        [
          "id": id, "project": "demo", "channel": "general", "title": title, "status": "open",
          "createdBy": "concierge-1", "createdAt": time, "updatedAt": time,
          "blockedBy": [String](), "requiredCapabilities": [String](),
          "stages": [["id": "s1", "name": "Build it"]], "stage": "s1", "stageSince": time,
          "stageSeq": 1, "body": "",
        ]
      })
  }

  /// The app signed in to nothing, showing the sample board as loaded.
  @MainActor static func app() -> AppModel {
    let (model, _) = fakeApp()
    model.store.show(projects: projects, tasks: tasks)
    model.sky.show(members: members, scheduler: scheduler)
    return model
  }

  private static func member(_ name: String, _ role: String, _ cli: String, _ memberships: [String])
    -> [String: Any]
  {
    [
      "name": name, "role": role, "cli": cli, "status": "active", "memberships": memberships,
      "lastModel": cli == "claude" ? "claude-opus-5-5" : "gpt-5.5-codex", "lastTurnAt": time,
    ]
  }

  private static func project(_ slug: String, _ name: String, _ order: Int) -> [String: Any] {
    [
      "slug": slug, "name": name, "defaultBranch": "main", "channels": ["general"],
      "members": [String](), "approvers": [String](),
      "createdAt": String(format: "2026-10-0%dT09:00:00.000Z", order),
    ]
  }

  private static func task(
    _ number: Int, _ project: String, _ title: String,
    stage: (id: String, name: String, agent: String?, role: String?), holder: String?,
    returned: Bool = false, completing: Bool = false
  ) -> [String: Any] {
    var current: [String: Any] = ["id": stage.id, "name": stage.name]
    current["agent"] = stage.agent
    current["role"] = stage.role
    var task: [String: Any] = [
      "id": id(number), "project": project, "channel": "general", "title": title,
      "status": holder == nil ? "open" : "claimed", "createdBy": "concierge-1", "createdAt": time,
      "updatedAt": time, "blockedBy": [String](), "requiredCapabilities": [String](),
      "stages": [current], "stage": stage.id, "stageSince": time, "stageSeq": 1,
      "completing": completing, "body": "",
    ]
    task["claimedBy"] = holder
    if returned {
      task["returned"] = ["from": "s2", "by": "rev-1", "at": time]
    }
    return task
  }

  private static func decode<T: Decodable>(_ value: [[String: Any]]) -> [T] {
    // The sample is made here, so it always encodes and decodes.
    let data = try! JSONSerialization.data(withJSONObject: value)
    return try! JSONDecoder().decode([T].self, from: data)
  }
}
