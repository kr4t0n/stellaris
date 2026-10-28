import Foundation
import Testing

@testable import BoardKit

/// Following the board's event stream across connections, over the stream the server wrote in the
/// fixtures' society: resuming after the last event, waiting longer after each drop, dropping a
/// connection that has gone silent, and stopping when the board refuses the token.
@Suite(.timeLimit(.minutes(1))) struct EventFollowerTests {
  /// What a scripted connection does, in order.
  enum Step: Sendable {
    case send(EventStreamItem)
    case wait(Duration)
    /// Ends the connection as the board closing it does.
    case end
    case fail(BoardError)
  }

  /// A board that answers each connection with the next script, and keeps what each asked for and
  /// how many the follower let go of. A connection whose script runs out stays open.
  actor ScriptedBoard {
    private var scripts: [[Step]]
    private(set) var asked: [String] = []
    private(set) var dropped = 0
    private(set) var pauses: [Duration] = []

    init(_ scripts: [[Step]]) {
      self.scripts = scripts
    }

    func next(since: String) -> [Step] {
      asked.append(since)
      return scripts.isEmpty ? [.fail(.unreachable)] : scripts.removeFirst()
    }

    func drop() { dropped += 1 }
    func pause(_ duration: Duration) { pauses.append(duration) }

    nonisolated func follower(silence: Duration = .seconds(45)) -> EventFollower {
      EventFollower(
        timing: EventFollower.Timing(silence: silence), pause: { await self.pause($0) },
        connect: { since in
          AsyncThrowingStream { continuation in
            let playing = Task {
              for step in await self.next(since: since) {
                switch step {
                case .send(let item): continuation.yield(item)
                case .wait(let duration): try? await Task.sleep(for: duration)
                case .end: continuation.finish()
                case .fail(let error): continuation.finish(throwing: error)
                }
              }
            }
            continuation.onTermination = { reason in
              playing.cancel()
              if case .cancelled = reason {
                Task { await self.drop() }
              }
            }
          }
        })
    }
  }

  /// The recorded stream's events, as one connection reads them from the server's text.
  private func recorded() throws -> [EventStreamItem] {
    let text = try #require(try Fixture("event-stream").text)
    var parser = ServerSentEventParser()
    return parser.push(contentsOf: Array(text.utf8)).map(eventStreamItem)
  }

  private func event(_ id: String) -> BoardEvent {
    BoardEvent(
      id: id, ts: "2026-01-01T00:00:00.000Z", type: "message.posted", actor: "eng-1",
      payload: ["channel": .string("general")])
  }

  /// The first `count` things the follower gives.
  private func first(_ count: Int, of follower: EventFollower) async throws -> [FollowedEvent] {
    var given: [FollowedEvent] = []
    for try await item in follower.follow() {
      given.append(item)
      if given.count == count {
        break
      }
    }
    return given
  }

  @Test func readsTheRecordedStreamAndItsPings() throws {
    let items = try recorded()
    #expect(items.count > 30)
    #expect(items.allSatisfy { if case .event = $0 { true } else { false } })
    // An idle stream's ping as the server writes it, and a frame the app can't read.
    var parser = ServerSentEventParser()
    let pings = parser.push(contentsOf: Array("event: ping\ndata: \n\ndata: {\"x\":1}\n\n".utf8))
    #expect(pings.map(eventStreamItem) == [.ping, .ping])
  }

  @Test func resumesAfterTheLastEventSeen() async throws {
    let items = try recorded()
    let events = items.compactMap { item -> BoardEvent? in
      if case .event(let event) = item { event } else { nil }
    }
    let last = try #require(events.last)
    let later = event("00000000000000000000000ZZZ")
    let board = ScriptedBoard([
      [.send(.opened)] + items.map(Step.send) + [.end],
      [.send(.opened), .send(.event(later))],
    ])
    let given = try await first(events.count + 2, of: board.follower())
    #expect(given == events.map(FollowedEvent.event) + [.resumed, .event(later)])
    #expect(await board.asked == ["latest", last.id])
  }

  @Test func waitsLongerAfterEachDropUpToFifteenSeconds() async throws {
    let failing: [Step] = [.fail(.unreachable)]
    let board = ScriptedBoard(
      Array(repeating: failing, count: 6) + [
        [.send(.opened), .send(.event(event("00000000000000000000000001"))), .end], failing,
        [.send(.opened), .send(.event(event("00000000000000000000000002")))],
      ])
    let given = try await first(4, of: board.follower())
    #expect(
      given == [
        .resumed, .event(event("00000000000000000000000001")), .resumed,
        .event(event("00000000000000000000000002")),
      ])
    // Once a connection opens, the next drop waits a second again.
    #expect(await board.pauses == [1, 2, 4, 8, 15, 15, 1, 2].map { Duration.seconds($0) })
    #expect(
      EventFollower.Timing()
        == EventFollower.Timing(
          firstWait: .seconds(1), longestWait: .seconds(15), silence: .seconds(45)))
  }

  @Test func dropsAConnectionThatHasGoneSilent() async throws {
    let first = event("00000000000000000000000001")
    let second = event("00000000000000000000000002")
    let board = ScriptedBoard([
      [.send(.opened), .send(.event(first))],
      [.send(.opened), .send(.event(second))],
    ])
    let clock = ContinuousClock()
    let started = clock.now
    let given = try await self.first(3, of: board.follower(silence: .milliseconds(200)))
    #expect(given == [.event(first), .resumed, .event(second)])
    #expect(clock.now - started >= .milliseconds(200))
    #expect(await board.asked == ["latest", first.id])
    #expect(await board.dropped >= 1)
  }

  @Test func keepsAConnectionThatPings() async throws {
    let late = event("00000000000000000000000001")
    let pings = Array(repeating: [Step.wait(.milliseconds(50)), .send(.ping)], count: 12).flatMap {
      $0
    }
    let board = ScriptedBoard([[.send(.opened)] + pings + [.send(.event(late))]])
    let given = try await first(1, of: board.follower(silence: .milliseconds(200)))
    #expect(given == [.event(late)])
    #expect(await board.asked == ["latest"])
  }

  @Test func stopsWhenTheBoardRefusesTheToken() async throws {
    let refused = BoardError(status: 401, code: "UNAUTHORIZED", message: "unknown token")
    let board = ScriptedBoard([[.fail(refused)]])
    await #expect(throws: BoardError.self) {
      _ = try await first(1, of: board.follower())
    }
    #expect(await board.asked == ["latest"])
    #expect(await board.pauses.isEmpty)
  }
}
