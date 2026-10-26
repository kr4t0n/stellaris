import BoardKit
import SwiftUI

/// The app: sign-in until a board takes a token, then the tabs.
struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Group {
      switch model.phase {
      case .starting: ProgressView()
      case .signedOut: SignInView()
      case .signedIn: ShellView()
      }
    }
    .task { await model.start() }
  }
}

/// Chat, Board, and Needs you, each with its own navigation stack. On a compact width iOS draws the
/// tab bar in the side bar, where a tab shows its icon alone.
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
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        Task { await model.refresh() }
      }
    }
  }
}

/// The conversation Chat holds, with Back to the one it came from.
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
        }
    }
  }
}
