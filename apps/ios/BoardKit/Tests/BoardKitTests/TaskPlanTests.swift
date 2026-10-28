import Foundation
import Testing

@testable import BoardKit

/// The task views' words for a task and its plan, on the cases the web's `tasks.test.ts` checks.
@Suite struct TaskPlanTests {
  private let ts = "2026-09-29T10:00:00.000Z"

  /// A task of two stages, the first done and the second, a gate, waiting, with `extra` over it.
  private func task(_ id: String, _ extra: [String: JSONValue] = [:]) throws -> BoardTask {
    var fields: [String: JSONValue] = [
      "id": .string(id), "project": .string("lab"), "channel": .string("general"),
      "title": .string(id), "status": .string("open"), "createdBy": .string("user"),
      "createdAt": .string(ts), "updatedAt": .string(ts), "blockedBy": .array([]),
      "requiredCapabilities": .array([]),
      "stages": .array([
        .object([
          "id": .string("s1"), "name": .string("draft"), "role": .string("writer"),
          "gate": .bool(false), "holders": .array([.string("ann")]),
          "completedBy": .string("ann"),
        ]),
        .object([
          "id": .string("s2"), "name": .string("review"), "role": .string("editor"),
          "gate": .bool(true), "holders": .array([]),
        ]),
      ]),
      "stage": .string("s2"), "stageSince": .string(ts), "stageSeq": .number(2),
      "onDone": .string("merge"), "completing": .bool(false), "body": .string(""),
    ]
    fields.merge(extra) { $1 }
    return try JSONDecoder().decode(BoardTask.self, from: JSONEncoder().encode(fields))
  }

  private func step(_ action: String, _ stage: String, to: String?) throws -> MessageStep {
    let fields: [String: JSONValue] = [
      "action": .string(action), "stage": .string(stage), "to": to.map(JSONValue.string) ?? .null,
    ]
    return try JSONDecoder().decode(MessageStep.self, from: JSONEncoder().encode(fields))
  }

  @Test func namesWhereATaskStands() throws {
    let back: JSONValue = .object(["from": .string("s2"), "by": .string("ed"), "at": .string(ts)])
    #expect(try task("a").phase == .waiting)
    #expect(try task("b", ["status": .string("claimed"), "claimedBy": .string("ed")]).phase == .working)
    #expect(try task("c", ["completing": .bool(true)]).phase == .landing)
    #expect(try task("d", ["status": .string("done")]).phase == .done)
    #expect(try task("e", ["status": .string("abandoned")]).phase == .abandoned)
    #expect(try task("f", ["stage": .string("s1"), "returned": back]).phase == .returned)
    #expect(try task("h", ["completing": .bool(true), "returned": back]).phase == .landing)
  }

  @Test func groupsTasksInViewOrderNewestFirst() throws {
    let groups = groupTasks([
      try task("old", ["status": .string("done"), "updatedAt": .string("2026-09-29T09:00:00.000Z")]),
      try task("new", ["status": .string("done"), "updatedAt": .string("2026-09-29T11:00:00.000Z")]),
      try task("waits"),
      try task("ties", ["status": .string("done"), "updatedAt": .string("2026-09-29T09:00:00.000Z")]),
    ])
    #expect(groups.map(\.phase) == [.waiting, .done])
    #expect(groups.map { $0.tasks.map(\.id) } == [["waits"], ["new", "old", "ties"]])
  }

  @Test func saysWhoMayHoldAStageAndHowFarATaskHasCome() throws {
    let plan = try task("a")
    #expect(plan.stages.map(assignee(of:)) == ["any writer", "any editor"])
    #expect(plan.progress == "Stage 2 of 2")
    #expect(try task("b", ["status": .string("done")]).progress == "All 2 stages done")
    #expect(try task("c", ["status": .string("abandoned")]).progress == "Abandoned")
    // A stage the plan no longer holds, as `findIndex` reads it.
    #expect(try task("d", ["stage": .string("s9")]).progress == "Stage 0 of 2")
    let captured = try JSONDecoder().decode(
      [BoardTask].self, from: try Fixture("tasks").body)
    #expect(
      captured.flatMap(\.stages).map(assignee(of:))
        == ["any engineer", "user", "rev-1", "anyone in the project"])
  }

  @Test func knowsTheCurrentStageAndItsHolder() throws {
    let waiting = try task("a")
    #expect(waiting.currentStage?.id == "s2")
    #expect(waiting.stages.map(waiting.isCurrent) == [false, true])
    #expect(waiting.holder == nil)
    let held = try task("b", ["status": .string("claimed"), "claimedBy": .string("ed")])
    #expect(held.holder == "ed")
    // Landing, ended, or of a status this client doesn't know, no stage is current.
    for extra: [String: JSONValue] in [
      ["completing": .bool(true)], ["status": .string("done")], ["status": .string("paused")],
    ] {
      #expect(try task("c", extra).currentStage == nil)
    }
  }

  @Test func namesAStepsStagesWhenTheTaskIsAtHand() throws {
    let plan = try task("a")
    func text(_ step: MessageStep, known: Bool = true) -> String? {
      stepLabel(step, task: known ? plan : nil)?.text
    }
    #expect(text(try step("advanced", "s1", to: "s2")) == "finished draft → review")
    #expect(text(try step("advanced", "s2", to: nil)) == "finished review")
    #expect(text(try step("returned", "s2", to: "s1")) == "sent back from review to draft")
    #expect(text(try step("returned", "s2", to: "s1"), known: false) == "sent back from s2 to s1")
    #expect(text(try step("returned", "s2", to: nil)) == "sent back from review to an earlier stage")
    #expect(text(try step("landed", "s2", to: nil)) == "landed")
    #expect(text(try step("reopened", "s2", to: "s2")) == "landing failed · back at review")
    #expect(stepLabel(try step("advanced", "s1", to: "s2"), task: plan)?.tone == .finished)
    #expect(stepLabel(try step("reopened", "s2", to: "s2"), task: plan)?.tone == .failed)
    let approved = try JSONDecoder().decode(MessageStep.self, from: Data(#"{"action":"approved"}"#.utf8))
    let rejected = try JSONDecoder().decode(MessageStep.self, from: Data(#"{"action":"rejected"}"#.utf8))
    #expect(stepLabel(approved, task: nil)?.text == "approved")
    #expect(stepLabel(rejected, task: nil)?.tone == .failed)
  }

  /// Who may decide a proposal, on the cases the web's `governance.test.ts` checks.
  @Test func namesWhoMayDecideLeavingOutTheProposer() throws {
    func proposal(_ kind: String, by proposer: String = "stew") throws -> Proposal {
      let charter: [String: JSONValue] =
        kind == "skill" ? ["name": .string("refereed-research"), "summary": .string("Plan.")] : [:]
      let fields: [String: JSONValue] = [
        "id": .string("01M3PY56V68VFS0EG5ER4B9AMD"), "kind": .string(kind),
        "proposedBy": .string(proposer), "status": .string("proposed"), "createdAt": .string(ts),
        "charter": .object(charter), "body": .string(""),
      ]
      return try JSONDecoder().decode(Proposal.self, from: JSONEncoder().encode(fields))
    }
    #expect(decidersOf(try proposal("skill"), proposerRole: "steward") == "you or another steward")
    #expect(decidersOf(try proposal("skill"), proposerRole: "concierge") == "you or the steward")
    #expect(decidersOf(try proposal("member"), proposerRole: "concierge") == "you")
    #expect(decidersOf(try proposal("role", by: "user"), proposerRole: "user") == "nobody")
  }
}
