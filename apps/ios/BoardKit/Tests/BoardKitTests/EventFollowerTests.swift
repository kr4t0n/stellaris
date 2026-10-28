import Foundation
import Synchronization
import Testing

@testable import BoardKit

/// Following the board's event stream across connections, over the stream the server wrote in the
/// fixtures' society: resuming after the last event, waiting longer after each drop, dropping a
/// connection that has gone silent, keeping one that pings, and stopping when the board refuses the
/// token. Silence is measured on a clock the tests move by hand, so no test hangs on how fast its
/// machine runs: on a busy simulator, sleeps that real-time tests rested on ran for tens of seconds.
@Suite(.timeLimit(.minutes(1))) struct EventFollowerTests {
  /// What a scripted connection does next.
  enum Step: Sendable {
    case send(EventStreamItem)
    /// Ends the connection as the board closing it does.
    case end
    case fail(BoardError)
  }

  /// A clock whose time moves only when a test moves it.
  final class ManualClock: Clock, Sendable {
    struct Instant: InstantProtocol {
      var offset: Duration

      func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
      func duration(to other: Instant) -> Duration { other.offset - offset }
      static func < (a: Instant, b: Instant) -> Bool { a.offset < b.offset }
    }

    private struct Sleeper {
      let deadline: Instant
      let continuation: CheckedContinuation<Void, any Error>
    }

    private struct State {
      var now = Instant(offset: .zero)
      var sleepers: [UUID: Sleeper] = [:]
    }

    private let state = Mutex(State())

    var now: Instant { state.withLock { $0.now } }
    var minimumResolution: Duration { .zero }

    /// How many sleep on the clock.
    var sleeping: Int { state.withLock { $0.sleepers.count } }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
      let id = UUID()
      try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          let woken: Result<Void, any Error>? = state.withLock { state in
            if Task.isCancelled {
              return .failure(CancellationError())
            }
            if deadline <= state.now {
              return .success(())
            }
            state.sleepers[id] = Sleeper(deadline: deadline, continuation: continuation)
            return nil
          }
          if let woken {
            continuation.resume(with: woken)
          }
        }
      } onCancel: {
        state.withLock { $0.sleepers.removeValue(forKey: id) }?.continuation.resume(
          throwing: CancellationError())
      }
    }

    /// Moves the clock on, waking whatever sleeps until then.
    func advance(by duration: Duration) {
      let due = state.withLock { state in
        state.now = state.now.advanced(by: duration)
        let now = state.now
        let due = state.sleepers.filter { $0.value.deadline <= now }
        for id in due.keys {
          state.sleepers[id] = nil
        }
        return due.values.map(\.continuation)
      }
      for continuation in due {
        continuation.resume()
      }
    }
  }

  /// A board whose connections send what each script says, then what the test sends them. It
  /// keeps what each connection asked for, how many items the follower has taken from each, and the
  /// waits between them.
  actor ScriptedBoard {
    private var scripts: [[Step]]
    private var queues: [[Step]] = []
    private var waiting: [Int: CheckedContinuation<Void, Never>] = [:]
    private(set) var asked: [String] = []
    /// How many items the follower has asked each connection for: once it asks for the next, it
    /// has handled the one before.
    private(set) var taken: [Int] = []
    private(set) var pauses: [Duration] = []

    init(_ scripts: [[Step]]) {
      self.scripts = scripts
    }

    /// Opens a connection: the next script, or a refusal to connect once they have run out.
    func open(since: String) -> Int {
      asked.append(since)
      queues.append(scripts.isEmpty ? [.fail(.unreachable)] : scripts.removeFirst())
      taken.append(0)
      return queues.count - 1
    }

    /// The connection's next step, once there is one; nil once the follower lets it go.
    func next(_ connection: Int) async -> Step? {
      taken[connection] += 1
      while queues[connection].isEmpty {
        await withTaskCancellationHandler {
          await withCheckedContinuation { waiting[connection] = $0 }
        } onCancel: {
          Task { await self.wake(connection) }
        }
        if Task.isCancelled {
          return nil
        }
      }
      return queues[connection].removeFirst()
    }

    private func wake(_ connection: Int) {
      waiting.removeValue(forKey: connection)?.resume()
    }

    /// Has connection `connection` send `step`.
    func send(_ step: Step, on connection: Int) {
      queues[connection].append(step)
      wake(connection)
    }

    /// Records the wait, and yields a moment rather than waiting it, so a follower that keeps
    /// reconnecting leaves the other tests room.
    func paused(_ duration: Duration) async {
      pauses.append(duration)
      try? await Task.sleep(for: .milliseconds(1))
    }

    nonisolated func follower<C: Clock>(
      clock: C, silence: Duration = .seconds(45)
    ) -> EventFollower<C> where C.Duration == Duration {
      EventFollower(
        clock: clock, timing: EventStreamTiming(silence: silence),
        pause: { await self.paused($0) },
        connect: { since in
          let connection = Task { await self.open(since: since) }
          return AsyncThrowingStream(unfolding: {
            let index = await connection.value
            switch await self.next(index) {
            case .send(let item)?: return item
            case .end?: return nil
            case .fail(let error)?: throw error
            case nil: return nil
            }
          })
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

  /// Follows in a task of its own, gathering the first `count` things the follower gives.
  private func following<C: Clock>(
    _ count: Int, of follower: EventFollower<C>
  ) -> Task<[FollowedEvent], any Error> where C.Duration == Duration {
    Task {
      var given: [FollowedEvent] = []
      for try await item in follower.follow() {
        given.append(item)
        if given.count == count {
          break
        }
      }
      return given
    }
  }

  /// Waits until `done`, which the follower's own tasks make true.
  private func until(_ done: () async -> Bool) async throws {
    while !(await done()) {
      try await Task.sleep(for: .milliseconds(5))
    }
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
    let given = try await following(events.count + 2, of: board.follower(clock: ManualClock()))
      .value
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
    let given = try await following(4, of: board.follower(clock: ManualClock())).value
    #expect(
      given == [
        .resumed, .event(event("00000000000000000000000001")), .resumed,
        .event(event("00000000000000000000000002")),
      ])
    // Once a connection opens, the next drop waits a second again.
    #expect(await board.pauses == [1, 2, 4, 8, 15, 15, 1, 2].map { Duration.seconds($0) })
    #expect(
      EventStreamTiming()
        == EventStreamTiming(
          firstWait: .seconds(1), longestWait: .seconds(15), silence: .seconds(45)))
  }

  @Test func dropsAConnectionSilentFor45Seconds() async throws {
    let clock = ManualClock()
    let first = event("00000000000000000000000001")
    let second = event("00000000000000000000000002")
    let board = ScriptedBoard([
      [.send(.opened), .send(.event(first))],
      [.send(.opened), .send(.event(second))],
    ])
    let given = following(3, of: board.follower(clock: clock))
    // The connection has given both and waits for more, and the follower times its silence.
    try await until { await board.taken == [3] && clock.sleeping == 1 }
    clock.advance(by: .seconds(44))
    #expect(clock.sleeping == 1, "a connection 44 s silent was dropped")
    #expect(await board.asked == ["latest"])
    clock.advance(by: .seconds(1))
    #expect(try await given.value == [.event(first), .resumed, .event(second)])
    #expect(await board.asked == ["latest", first.id])
  }

  @Test func keepsAConnectionThatPings() async throws {
    let clock = ManualClock()
    let late = event("00000000000000000000000001")
    let board = ScriptedBoard([[.send(.opened)]])
    let given = following(1, of: board.follower(clock: clock))
    try await until { await board.taken == [2] && clock.sleeping == 1 }
    // A ping every 30 s for two minutes, against the 45 s limit; each once the follower has it.
    for ping in 1...4 {
      clock.advance(by: .seconds(30))
      await board.send(.send(.ping), on: 0)
      try await until { await board.taken == [2 + ping] }
    }
    await board.send(.send(.event(late)), on: 0)
    #expect(try await given.value == [.event(late)])
    #expect(await board.asked == ["latest"])
  }

  /// Started again with nothing to ask after, the follower counts its first connection as one
  /// after a drop, so what came meanwhile is read again.
  @Test func resumesAtTheFirstConnectionWhenAsked() async throws {
    let late = event("00000000000000000000000001")
    let board = ScriptedBoard([[.send(.opened), .send(.event(late))]])
    let follower = board.follower(clock: ManualClock())
    var given: [FollowedEvent] = []
    for try await item in follower.follow(resuming: true) {
      given.append(item)
      if given.count == 2 {
        break
      }
    }
    #expect(given == [.resumed, .event(late)])
    #expect(await board.asked == ["latest"])
  }

  @Test func stopsWhenTheBoardRefusesTheToken() async throws {
    let refused = BoardError(status: 401, code: "UNAUTHORIZED", message: "unknown token")
    let board = ScriptedBoard([[.fail(refused)]])
    await #expect(throws: BoardError.self) {
      _ = try await following(1, of: board.follower(clock: ManualClock())).value
    }
    #expect(await board.asked == ["latest"])
    #expect(await board.pauses.isEmpty)
  }
}
