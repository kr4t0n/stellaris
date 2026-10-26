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

  @Test func encodesTheValueItRead() throws {
    for raw in ["open", "paused"] {
      let value = OrUnknown<BoardTask.Status>(rawValue: raw)
      #expect(String(decoding: try JSONEncoder().encode(value), as: UTF8.self) == #""\#(raw)""#)
    }
    #expect(OrUnknown<BoardTask.Status>(rawValue: "open").value == .open)
    #expect(OrUnknown<BoardTask.Status>(rawValue: "paused").value == nil)
  }
}
