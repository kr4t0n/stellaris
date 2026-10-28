import Foundation
import Testing

@testable import BoardKit

/// A server newer than the app may add a value to any closed set. The captured answers, each with
/// one value changed to one this client doesn't know, still decode, with that value unknown.
@Suite struct UnknownValueTests {
  /// The fixture's answer with its first `"key":"value"` changed to `"key":"replacement"`.
  private func answer(
    _ name: String, _ key: String, _ value: String, to replacement: String
  ) throws -> Data {
    let text = String(decoding: try Fixture(name).body, as: UTF8.self)
    let range = try #require(text.range(of: #""\#(key)":"\#(value)""#))
    return Data(text.replacingCharacters(in: range, with: #""\#(key)":"\#(replacement)""#).utf8)
  }

  @Test func aProjectsCompletionEffect() throws {
    let data = try answer("projects", "onDone", "none", to: "rebase")
    let projects = try JSONDecoder().decode([Project].self, from: data)
    #expect(projects.map(\.onDone) == [.unknown("rebase")])
  }

  @Test func aTasksStatusLeavesItsStageToNobody() throws {
    let data = try answer("tasks", "status", "claimed", to: "paused")
    let tasks = try JSONDecoder().decode([BoardTask].self, from: data)
    #expect(tasks.map(\.status) == [.known(.open), .unknown("paused")])
    #expect(tasks.map(TaskPhase.init(of:)) == [.waiting, .unknown])
    #expect(tasks.map { stageForYou($0)?.id } == ["s2", nil])
  }

  @Test func aProposalsKindStillWaitsOnTheUser() throws {
    let data = try answer("proposals", "kind", "member", to: "budget")
    let proposals = try JSONDecoder().decode([Proposal].self, from: data)
    #expect(proposals.map(\.kind.rawValue) == ["budget", "channel", "reallocation"])
    #expect(proposals.map(waitingOnYou) == [true, true, true])
  }

  @Test func aStepsAction() throws {
    let data = try answer("thread", "action", "advanced", to: "paused")
    let detail = try JSONDecoder().decode(ThreadDetail.self, from: data)
    let step = TaskStep(action: .unknown("paused"), stage: "s1", to: "s2")
    #expect(detail.messages.first?.step == .task(step))
  }

  @Test func aDecisionsOutcome() throws {
    let data = try answer("approve", "outcome", "approved", to: "deferred")
    #expect(try JSONDecoder().decode(Decision.self, from: data).outcome == .unknown("deferred"))
  }

  /// The captured channel's first message, carrying `notice`.
  private func message(withNotice notice: [String: Any]) throws -> Message {
    var messages = try #require(
      try JSONSerialization.jsonObject(with: try Fixture("channel").body) as? [[String: Any]])
    messages[0]["notice"] = notice
    let data = try JSONSerialization.data(withJSONObject: messages)
    return try #require(try JSONDecoder().decode([Message].self, from: data).first)
  }

  /// The captured task thread's first message, carrying `step`.
  private func message(withStep step: [String: Any]) throws -> Message {
    var detail = try #require(
      try JSONSerialization.jsonObject(with: try Fixture("thread").body) as? [String: Any])
    var messages = try #require(detail["messages"] as? [[String: Any]])
    messages[0]["step"] = step
    detail["messages"] = messages
    let data = try JSONSerialization.data(withJSONObject: detail)
    return try #require(try JSONDecoder().decode(ThreadDetail.self, from: data).messages.first)
  }

  @Test func aNoticeOfAKindItDoesNotKnow() throws {
    let notice = try #require(
      try message(withNotice: ["kind": "cron", "action": "fired", "cron": "daily"]).notice)
    #expect(notice.kind == "cron")
    let fields: [String: JSONValue] = [
      "kind": .string("cron"), "action": .string("fired"), "cron": .string("daily"),
    ]
    #expect(notice == .unknown(fields))
  }

  @Test func aKnowledgeNoticeWithANewActionOrWithoutItsTopic() throws {
    let archived = try message(withNotice: [
      "kind": "knowledge", "action": "archived", "topic": "flow", "project": "demo",
    ])
    let notice = KnowledgeNotice(action: .unknown("archived"), topic: "flow", project: "demo")
    #expect(archived.notice == .knowledge(notice))
    let untitled = try message(withNotice: ["kind": "knowledge", "action": "written"])
    let fields: [String: JSONValue] = ["kind": .string("knowledge"), "action": .string("written")]
    #expect(untitled.notice == .unknown(fields))
  }

  @Test func aStepOfAShapeItDoesNotKnow() throws {
    let merged = try message(withStep: ["kind": "merged", "sha": "abc"])
    #expect(merged.step == .unknown(["kind": .string("merged"), "sha": .string("abc")]))
    let deferred = try message(withStep: ["action": "deferred"])
    #expect(deferred.step == .proposal(ProposalStep(action: .unknown("deferred"))))
    let unplanned = try message(withStep: ["action": "abandoned", "stage": "s1"])
    #expect(unplanned.step == .task(TaskStep(action: .known(.abandoned), stage: "s1", to: nil)))
  }

  @Test func encodesTheValueItRead() throws {
    for raw in ["open", "paused"] {
      let value = OrUnknown<BoardTask.Status>(rawValue: raw)
      #expect(String(decoding: try JSONEncoder().encode(value), as: UTF8.self) == #""\#(raw)""#)
    }
    #expect(OrUnknown<BoardTask.Status>(rawValue: "open").value == .open)
    #expect(OrUnknown<BoardTask.Status>(rawValue: "paused").value == nil)
  }
}
