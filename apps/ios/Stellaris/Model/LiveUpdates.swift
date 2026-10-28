import BoardKit
import Foundation

/// Keeps what the app shows current while it is in front, as the web's `followBoardEvents` and
/// `refreshFor` do: it follows the board's events through `EventFollower`, from the end of the log
/// at first and after the last event it had when the app comes back to the front, and reads again
/// what `staleKeys` says each made stale, once for a burst; after a drop, when events may have been
/// missed, everything the app has read, and so too when it comes back to the front with no event
/// to ask after, since it then starts again at the end of the log.
@MainActor final class LiveUpdates {
  /// How long a burst of events gathers before what they made stale is read again.
  var settle = Duration.milliseconds(250)
  /// The last event the board's stream gave, which the next follow asks after.
  private(set) var last: String?
  /// Whether it has followed the board since the sign-in.
  private(set) var followed = false
  private var stale: Set<ReadKey> = []
  private var everything = false
  private var rereading: Task<Void, Never>?

  /// Follows the board until cancelled, as the tabs do while the app is in front. A token the board
  /// no longer takes ends the sign-in.
  func follow(using model: AppModel) async {
    guard let follower = model.eventFollower() else {
      return
    }
    let signIn = model.generation
    // Back with no event to ask after, it misses what came meanwhile unless it reads it all again.
    let resuming = followed && last == nil
    followed = true
    do {
      for try await item in follower.follow(since: last ?? "latest", resuming: resuming) {
        guard model.generation == signIn else {
          return
        }
        switch item {
        case .event(let event):
          last = event.id
          take(staleKeys(for: event), using: model)
        case .resumed:
          takeEverything(using: model)
        }
      }
    } catch {
      _ = model.ended(by: error)
    }
  }

  /// Gathers what an event made stale, which is read again a moment later.
  func take(_ keys: [ReadKey], using model: AppModel) {
    guard !keys.isEmpty else {
      return
    }
    stale.formUnion(keys)
    schedule(using: model)
  }

  /// Reads everything again, as after a drop.
  func takeEverything(using model: AppModel) {
    everything = true
    schedule(using: model)
  }

  private func schedule(using model: AppModel) {
    guard rereading == nil else {
      return
    }
    rereading = Task {
      try? await Task.sleep(for: settle)
      while !Task.isCancelled, !stale.isEmpty || everything {
        let keys = stale
        let all = everything
        stale = []
        everything = false
        await model.reread(keys, everything: all)
      }
      // A cleared one has been let go of already, and another may have taken its place.
      if !Task.isCancelled {
        rereading = nil
      }
    }
  }

  /// Drops what was gathered, as signing out does.
  func clear() {
    rereading?.cancel()
    rereading = nil
    last = nil
    followed = false
    stale = []
    everything = false
  }
}
