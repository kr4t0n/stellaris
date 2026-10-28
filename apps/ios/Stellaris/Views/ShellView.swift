import BoardKit
import SwiftUI

/// The app: sign-in until a board takes a token, then the tabs, with the sky beside them on the
/// inner display.
struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      switch model.phase {
      case .starting: ProgressView()
      case .signedOut: SignInView()
      case .signedIn:
        if RootView.showsSkyAlone {
          SkyView()
        } else {
          AppLayout()
        }
      }
    }
    .task { await model.start() }
    // The board's events, while signed in and in front; iOS suspends the app in the background.
    .task(id: model.phase == .signedIn && scenePhase == .active) {
      if model.phase == .signedIn, scenePhase == .active {
        await model.live.follow(using: model)
      }
    }
  }

  /// A debug build launched with `-StellarisSky` shows the sky alone in its window, the plain
  /// frame the UI tests drive it in, since it shows only on the inner display, which the
  /// simulator in CI keeps closed.
  private static var showsSkyAlone: Bool {
    #if DEBUG
      ProcessInfo.processInfo.arguments.contains("-StellarisSky")
    #else
      false
    #endif
  }
}

/// Chat, Board, and Needs you, each with its own navigation stack. On a compact width iOS draws the
/// tab bar in the side bar, where a tab shows its icon alone; `AppLayout` places it beside or below
/// the sky on the inner display.
struct ShellView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    @Bindable var model = model
    TabView(selection: $model.tab) {
      Tab("Chat", systemImage: "bubble.left.and.bubble.right", value: AppTab.chat) {
        ChatView()
      }
      Tab("Board", systemImage: "square.grid.2x2", value: AppTab.board) {
        BoardView()
      }
      Tab("Needs you", systemImage: "bell", value: AppTab.needsYou) {
        NeedsYouView()
      }
      .badge(model.store.attention.count)
    }
    .sheet(isPresented: $model.showsSettings) {
      SettingsView()
    }
    .fullScreenCover(item: $model.viewing) { viewed in
      ImageViewer(image: viewed.image, alt: viewed.alt)
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        Task { await model.refresh() }
      }
    }
  }
}

/// The conversation Chat holds, with Back to the one it came from, and in a channel that takes
/// posts, New thread, which the bar keeps longest as it runs out of room.
struct ChatView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    NavigationStack {
      ConversationView(feed: model.feed(for: model.history.current))
        .id(model.history.current)
        .toolbar {
          if let back = model.back {
            ToolbarItem(placement: .cancellationAction) {
              Button {
                model.goBack()
              } label: {
                Label("Back to \(model.name(of: back))", systemImage: "chevron.backward")
              }
              .accessibilityIdentifier("back")
            }
          }
          if let channel = openChannel {
            ToolbarItem(placement: .primaryAction) {
              Button {
                model.startingThread = channel
              } label: {
                Label("New thread", systemImage: "plus.bubble")
              }
              .accessibilityIdentifier("new-thread")
            }
            .visibilityPriority(.high)
          }
        }
    }
    // Presented here rather than by the conversation, which a fold may build again.
    .sheet(isPresented: startingThread) {
      if let channel = model.startingThread {
        NewThreadSheet(channel: channel)
      }
    }
  }

  /// The channel Chat shows, if it takes posts.
  private var openChannel: String? {
    guard case .channel(let ref) = model.history.current, model.store.readOnly(ref) == nil else {
      return nil
    }
    return ref
  }

  private var startingThread: Binding<Bool> {
    Binding(
      get: { model.startingThread != nil },
      set: { shown in
        if !shown {
          model.startingThread = nil
        }
      })
  }
}
