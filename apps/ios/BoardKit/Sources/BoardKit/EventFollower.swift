import Foundation

/// What one connection to the board's event stream gives: word that the board answered, then each
/// event and each ping, which an idle stream writes every fifteen seconds to say it is alive.
public enum EventStreamItem: Sendable, Hashable {
  case opened
  case event(BoardEvent)
  case ping
}

/// A frame of the board's event stream: an event, or a ping, which has the type `ping` and no data.
/// A frame that doesn't read as an event says the connection is alive and nothing more, as a ping
/// does, so one the app can't read never ends the stream.
public func eventStreamItem(_ frame: ServerSentEvent) -> EventStreamItem {
  guard frame.event != "ping", !frame.data.isEmpty,
    let event = try? JSONDecoder().decode(BoardEvent.self, from: Data(frame.data.utf8))
  else {
    return .ping
  }
  return .event(event)
}

/// What following the board gives: each event, and word that a connection opened after a drop, when
/// events may have been missed, so that everything shown is read again, as the web does.
public enum FollowedEvent: Sendable, Hashable {
  case event(BoardEvent)
  case resumed
}

/// Follows the board's event stream across drops, as the web's `followBoardEvents` and
/// `followStream` do: each connection asks for the events after the last one seen, since the board
/// reads `since` and not `Last-Event-ID`; after a drop it waits a second, then twice as long each
/// time up to fifteen seconds, until a connection opens again. It also drops a connection that has
/// sent nothing for 45 seconds, pings included, which the board writes every fifteen, since a
/// connection that died unnoticed would otherwise wait for the transport's own timeout.
public struct EventFollower: Sendable {
  public struct Timing: Sendable, Hashable {
    /// The wait after the first drop, which each further drop doubles.
    public var firstWait: Duration
    public var longestWait: Duration
    /// How long a connection may send nothing before it is dropped.
    public var silence: Duration

    public init(
      firstWait: Duration = .seconds(1), longestWait: Duration = .seconds(15),
      silence: Duration = .seconds(45)
    ) {
      self.firstWait = firstWait
      self.longestWait = longestWait
      self.silence = silence
    }
  }

  /// Opens one connection to the stream after the event `since` names, or `latest`.
  public typealias Connect =
    @Sendable (_ since: String) -> AsyncThrowingStream<EventStreamItem, any Error>

  private let connect: Connect
  private let timing: Timing
  private let pause: @Sendable (Duration) async throws -> Void

  /// `pause` waits between connections; the tests pass one that records how long.
  public init(
    timing: Timing = Timing(), pause: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    }, connect: @escaping Connect
  ) {
    self.connect = connect
    self.timing = timing
    self.pause = pause
  }

  /// The board's events from `since` on, until cancelled. It ends by throwing only when the board
  /// refuses the token, which no connection made again would change.
  public func follow(since start: String = "latest") -> AsyncThrowingStream<FollowedEvent, any Error>
  {
    let connect = connect
    let timing = timing
    let pause = pause
    return AsyncThrowingStream { continuation in
      let following = Task {
        var since = start
        var wait = timing.firstWait
        var dropped = false
        while !Task.isCancelled {
          let resumes = dropped
          let reading = await EventFollower.read(
            connect(since), silence: timing.silence,
            opened: {
              if resumes {
                continuation.yield(.resumed)
              }
            },
            event: { continuation.yield(.event($0)) })
          if let last = reading.last {
            since = last
          }
          if reading.opened {
            wait = timing.firstWait
          }
          if let error = reading.error as? BoardError, error.isUnauthorized {
            continuation.finish(throwing: error)
            return
          }
          guard !Task.isCancelled else {
            break
          }
          dropped = true
          do {
            try await pause(wait)
          } catch {
            break
          }
          wait = min(wait * 2, timing.longestWait)
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in following.cancel() }
    }
  }

  /// What one connection gave: whether it opened, the last event, and how it ended if it failed.
  private struct Reading: Sendable {
    var opened = false
    var last: String?
    var error: (any Error)?
  }

  /// How a connection ended.
  private enum Ending: Sendable {
    case ended
    case failed(any Error)
    case silent
  }

  /// When a connection was last heard from, and what it gave.
  private actor Heard {
    var at = ContinuousClock.now
    var reading = Reading()

    func hear(_ item: EventStreamItem) {
      at = .now
      switch item {
      case .opened: reading.opened = true
      case .event(let event): reading.last = event.id
      case .ping: break
      }
    }
  }

  /// Reads one connection until it ends, fails, or sends nothing for `silence`, which drops it.
  private static func read(
    _ items: AsyncThrowingStream<EventStreamItem, any Error>, silence: Duration,
    opened: @escaping @Sendable () -> Void, event: @escaping @Sendable (BoardEvent) -> Void
  ) async -> Reading {
    let heard = Heard()
    let ending = await withTaskGroup(of: Ending?.self) { group in
      group.addTask {
        do {
          for try await item in items {
            await heard.hear(item)
            switch item {
            case .opened: opened()
            case .event(let each): event(each)
            case .ping: break
            }
          }
          return .ended
        } catch {
          return .failed(error)
        }
      }
      group.addTask {
        while !Task.isCancelled {
          let due = await heard.at + silence
          do {
            try await Task.sleep(until: due, clock: .continuous)
          } catch {
            return nil
          }
          if await heard.at + silence <= ContinuousClock.now {
            return .silent
          }
        }
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
    var reading = await heard.reading
    if case .failed(let error) = ending {
      reading.error = error
    }
    return reading
  }
}
