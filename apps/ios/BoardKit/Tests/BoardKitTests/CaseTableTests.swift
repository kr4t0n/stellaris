import Testing

@testable import BoardKit

/// The ports run the case tables the web's own `staleKeys` and `needsYou` tests run.
@Suite struct CaseTableTests {
  struct StaleKeysCase: Decodable {
    let event: BoardEvent
    let keys: [ReadKey]
  }

  struct NeedsYouCase: Decodable {
    let name: String
    let proposals: [Proposal]
    let tasks: [BoardTask]
    let requests: [UserRequest]
    let expected: [Item]
  }

  /// An item of `needsYou` as the table writes it.
  struct Item: Decodable, Equatable {
    let kind: String
    let id: String
    let stage: String?
    let thread: String?
    let since: String
  }

  @Test func staleKeysAgreesWithTheWeb() throws {
    let cases = try Fixture.table("stale-keys", as: [StaleKeysCase].self)
    #expect(cases.count > 60)
    for each in cases {
      #expect(staleKeys(for: each.event) == each.keys, "\(each.event.type)")
    }
  }

  @Test func anEventTypeTheClientDoesNotKnowTouchesNothing() throws {
    let cases = try Fixture.table("stale-keys", as: [StaleKeysCase].self)
    let known = try #require(cases.first).event
    let unknown = BoardEvent(
      id: known.id, ts: known.ts, type: "garden.watered", actor: known.actor, payload: [:])
    #expect(staleKeys(for: unknown).isEmpty)
  }

  @Test func needsYouAgreesWithTheWeb() throws {
    let cases = try Fixture.table("needs-you", as: [NeedsYouCase].self)
    #expect(cases.count > 10)
    for each in cases {
      let items = needsYou(proposals: each.proposals, tasks: each.tasks, requests: each.requests)
        .map { item -> Item in
          switch item {
          case .proposal(let proposal, let since):
            Item(kind: "proposal", id: proposal.id, stage: nil, thread: nil, since: since)
          case .stage(let task, let stage, let since):
            Item(kind: "stage", id: task.id, stage: stage.id, thread: nil, since: since)
          case .request(let message, let thread, let since):
            Item(kind: "request", id: message.id, stage: nil, thread: thread?.id, since: since)
          }
        }
      #expect(items == each.expected, "\(each.name)")
    }
  }
}
