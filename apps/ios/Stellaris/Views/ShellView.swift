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

/// The conversation Chat holds, with Back to the one it came from. A channel that takes posts has
/// New thread in the bar, which the bar keeps longest as it runs out of room. A task's thread has
/// Advance pinned at the bar's end while its stage waits on the user, then Plan; a proposal's has
/// Approve pinned while it waits on the user, then Reject, then Charter. The plan or the charter
/// opens beside the thread where it leaves the thread a column of its own, and in a sheet
/// otherwise; the forms open in system sheets, which iOS moves off a fold.
struct ChatView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var sizeClass
  /// How wide Chat is, which decides whether the plan or the charter fits beside the thread.
  @State private var width: CGFloat = 0

  var body: some View {
    let subject = model.subject(of: model.history.current)
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
          if case .task(let task)? = subject {
            if stageForYou(task) != nil {
              ToolbarItem(placement: .topBarPinnedTrailing) {
                Button {
                  model.advancing = task.id
                } label: {
                  Label("Advance", systemImage: "checkmark.circle")
                }
                .accessibilityIdentifier("advance")
              }
            }
            ToolbarItem(placement: .primaryAction) {
              Button {
                toggleInspector(task.id)
              } label: {
                Label("Plan", systemImage: "list.number")
              }
              .accessibilityIdentifier("plan")
            }
            .visibilityPriority(.high)
          }
          if case .proposal(let proposal)? = subject {
            if waitingOnYou(proposal) {
              ToolbarItem(placement: .topBarPinnedTrailing) {
                Button {
                  model.deciding = Verdict(proposal: proposal.id, choice: .approve)
                } label: {
                  Label("Approve", systemImage: "checkmark.seal")
                }
                .accessibilityIdentifier("approve")
              }
              ToolbarItem(placement: .primaryAction) {
                Button {
                  model.deciding = Verdict(proposal: proposal.id, choice: .reject)
                } label: {
                  Label("Reject", systemImage: "xmark.seal")
                }
                .accessibilityIdentifier("reject")
              }
              .visibilityPriority(.high)
            }
            ToolbarItem(placement: .primaryAction) {
              Button {
                toggleInspector(proposal.id)
              } label: {
                Label("Charter", systemImage: "doc.text")
              }
              .accessibilityIdentifier("charter")
            }
          }
        }
        .inspector(isPresented: inspectorShown) {
          if let subject {
            SubjectDetail(subject: subject)
              .inspectorColumnWidth(min: 280, ideal: 320, max: 400)
          }
        }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    // Presented here rather than by the conversation, which a fold may build again.
    .sheet(item: sheet) { shown in
      switch shown {
      case .newThread(let channel):
        NewThreadSheet(channel: channel)
      case .advance(let task):
        AdvanceSheet(taskId: task)
      case .decide(let verdict):
        DecisionSheet(verdict: verdict)
      case .inspect:
        if let subject {
          NavigationStack {
            SubjectDetail(subject: subject)
              .navigationTitle(subject.isTask ? "Plan" : "Charter")
              .navigationBarTitleDisplayMode(.inline)
              .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                  Button("Done") {
                    model.inspecting = nil
                  }
                  .accessibilityIdentifier("inspector-done")
                }
              }
          }
          .presentationDetents([.medium, .large])
        }
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

  private var inspectorFits: Bool {
    ChatView.inspectorFits(regular: sizeClass == .regular, width: width)
  }

  /// Whether the plan or the charter fits beside the thread: with a regular width, and room for
  /// the thread and the inspector each to have a column of 320 points. On the inner display that
  /// is portrait, flat or folded on a table, where the chat has the window's width; in landscape,
  /// flat or folded like a book, the chat has half, and the plan opens in a sheet.
  static func inspectorFits(regular: Bool, width: CGFloat) -> Bool {
    regular && width >= 640
  }

  /// The id of the task or the proposal Chat shows.
  private var subjectId: String? {
    guard case .thread(let id) = model.history.current, model.subject(of: .thread(id)) != nil
    else {
      return nil
    }
    return id
  }

  private func toggleInspector(_ id: String) {
    model.inspecting = model.inspecting == id ? nil : id
  }

  /// Whether the inspector shows: the model's alone to say. iOS gives the column no control of its
  /// own to close it, and SwiftUI writes it closed as a fold moves the plan from its sheet to the
  /// column, so Plan, the strip, and Done close it, never a write here.
  private var inspectorShown: Binding<Bool> {
    Binding(
      get: { inspectorFits && subjectId != nil && model.inspecting == subjectId },
      set: { _ in })
  }

  /// The sheet Chat presents, from what the model says is open: a sheet dismissed by a swipe
  /// closes what it shows, and one taken away because the model changed closes nothing more.
  private var sheet: Binding<ChatSheet?> {
    Binding(
      get: { shownSheet },
      set: { next in
        guard next == nil, let shown = shownSheet else {
          return
        }
        switch shown {
        case .newThread: model.startingThread = nil
        case .advance: model.advancing = nil
        case .decide: model.deciding = nil
        case .inspect: model.inspecting = nil
        }
      })
  }

  private var shownSheet: ChatSheet? {
    if let channel = model.startingThread {
      return .newThread(channel)
    }
    if let task = model.advancing {
      return .advance(task)
    }
    if let verdict = model.deciding {
      return .decide(verdict)
    }
    // Once Chat's width is known, so the plan doesn't flash in a sheet before its column.
    if width > 0, !inspectorFits, let id = subjectId, model.inspecting == id {
      return .inspect(id)
    }
    return nil
  }
}

/// A sheet Chat presents.
enum ChatSheet: Hashable, Identifiable {
  case newThread(String)
  case advance(String)
  case decide(Verdict)
  case inspect(String)

  var id: Self { self }
}

/// A task's plan or a proposal's charter.
struct SubjectDetail: View {
  @Environment(AppModel.self) private var model
  let subject: Subject

  var body: some View {
    Group {
      switch subject {
      case .task(let task): PlanView(task: task)
      case .proposal(let proposal): CharterView(proposal: proposal)
      }
    }
    .modifier(FollowsBoardLinks { model.inspecting = nil })
  }
}

extension Subject {
  var isTask: Bool {
    if case .task = self { true } else { false }
  }
}
