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
/// the sky on the inner display. The icons are outlines, as Safari's side bar draws its own, where
/// a tab bar's are filled, and Chat's is one bubble, as wide as the others.
struct ShellView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    @Bindable var model = model
    TabView(selection: $model.tab) {
      Tab(value: AppTab.chat) {
        ChatView()
      } label: {
        TabLabel(title: "Chat", symbol: "bubble.left")
      }
      Tab(value: AppTab.board) {
        BoardView()
      } label: {
        TabLabel(title: "Board", symbol: "square.grid.2x2")
      }
      Tab(value: AppTab.needsYou) {
        NeedsYouView()
      } label: {
        TabLabel(title: "Needs you", symbol: "bell")
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

/// A tab's title and its symbol as an outline, which a tab bar would otherwise fill.
private struct TabLabel: View {
  let title: String
  let symbol: String

  var body: some View {
    Label(title, systemImage: symbol)
      .environment(\.symbolVariants, .none)
  }
}

/// The conversation Chat holds, with Back to the one it came from. A channel that takes posts has
/// New thread in the bar, which the bar keeps longest as it runs out of room. A task's thread has
/// Advance pinned at the bar's end while its stage waits on the user, then Plan; a proposal's has
/// Approve pinned while it waits on the user, then Reject, then Charter. The plan or the charter
/// opens in a column beside the thread where both have room, and in a sheet otherwise; the forms
/// open in system sheets, which iOS moves off a fold.
struct ChatView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var sizeClass
  /// How wide Chat is now.
  @State private var width: CGFloat = 0
  /// The width Chat last kept for a fifth of a second, which decides whether the plan or the
  /// charter goes beside the thread: a resize passes through widths it doesn't stop at, and a sheet
  /// presented at one of them stayed up once the plan had moved to its column. Zero until then.
  @State private var settled: CGFloat = 0
  /// Where the plan goes, as last settled, for the sheet's binding to read when SwiftUI writes it:
  /// read from the view, a turn that moved the plan from its sheet to its column closed it.
  @State private var placement = PlanPlacement()

  var body: some View {
    let subject = model.subject(of: model.history.current)
    HStack(spacing: 0) {
      // The thread's stack, and the plan's or the charter's beside it: two stacks side by side,
      // since a stack inside another's view pushes onto the outer one.
      NavigationStack {
        HStack(spacing: 0) {
          ConversationView(feed: model.feed(for: model.history.current))
            .id(model.history.current)
        }
          // What shows where no view draws, as behind the keyboard's rounded corners, below the
          // foot the conversation's own ground ends at while the keyboard is up: the island, not
          // the stack's black.
          .containerBackground(MessageColor.island, for: .navigation)
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
                  .disabled(model.underWay.contains(task.id))
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
                  .disabled(model.underWay.contains(proposal.id))
                  .accessibilityIdentifier("approve")
                }
                ToolbarItem(placement: .primaryAction) {
                  Button {
                    model.deciding = Verdict(proposal: proposal.id, choice: .reject)
                  } label: {
                    Label("Reject", systemImage: "xmark.seal")
                  }
                  .disabled(model.underWay.contains(proposal.id))
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
      }
      if columnShown, let subject {
        Rectangle().fill(MessageColor.line).frame(width: 1)
        SubjectStack(subject: subject, placement: placement, beside: true)
          .frame(width: 320)
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .task(id: width) {
      try? await Task.sleep(for: .milliseconds(200))
      guard !Task.isCancelled else {
        return
      }
      placement.beside = ChatView.inspectorFits(regular: sizeClass == .regular, width: width)
      placement.known = width > 0
      settled = width
    }
    // Presented here rather than by the conversation, which a fold may build again.
    .sheet(item: sheet) { shown in
      switch shown {
      case .newThread(let channel):
        NewThreadSheet(channel: channel)
      case .advance(let task):
        AdvanceSheet(taskId: task)
      case .decide(let verdict):
        DecisionSheet(verdict: verdict)
      case .files:
        FileSheet()
      case .inspect:
        if let subject {
          // No button: it only shows the plan or the charter, so a drag down closes it.
          SubjectStack(subject: subject, placement: placement, beside: false)
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
    ChatView.inspectorFits(regular: sizeClass == .regular, width: settled)
  }

  /// Whether the plan or the charter fits beside the thread: with a regular width, and room for
  /// the thread and the plan's column each to have 320 points. On the inner display that
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

  /// Whether the plan or the charter shows in its column beside the thread.
  private var columnShown: Bool {
    inspectorFits && subjectId != nil && model.inspecting == subjectId
  }

  /// The sheet Chat presents, from what the model says is open: a sheet dismissed by a swipe
  /// closes what it shows, and one taken away because the model changed, or because the plan moved
  /// to its column, closes nothing more.
  private var sheet: Binding<ChatSheet?> {
    let placement = placement
    return Binding(
      get: { shownSheet(known: settled > 0, beside: inspectorFits) },
      set: { next in
        guard next == nil,
          let shown = shownSheet(known: placement.known, beside: placement.beside)
        else {
          return
        }
        switch shown {
        case .newThread: model.startingThread = nil
        case .advance: model.advancing = nil
        case .decide: model.deciding = nil
        case .files: model.browsing = nil
        case .inspect: model.inspecting = nil
        }
      })
  }

  /// The sheet the model asks for, with the plan or the charter in one only once Chat's width is
  /// known and leaves it no column.
  private func shownSheet(known: Bool, beside: Bool) -> ChatSheet? {
    if let channel = model.startingThread {
      return .newThread(channel)
    }
    if let task = model.advancing {
      return .advance(task)
    }
    if let verdict = model.deciding {
      return .decide(verdict)
    }
    // Before the plan, since a file a link in the plan opened takes the plan's sheet.
    if let browse = model.browsing {
      return .files(browse.root)
    }
    if known, !beside, let id = subjectId, model.inspecting == id {
      return .inspect(id)
    }
    return nil
  }
}

/// Where the plan or the charter goes, as Chat last settled it: beside the thread or in a sheet,
/// and whether Chat's width is known yet.
@MainActor private final class PlanPlacement {
  var beside = false
  var known = false
}

/// A sheet Chat presents.
enum ChatSheet: Hashable, Identifiable {
  case newThread(String)
  case advance(String)
  case decide(Verdict)
  /// A file or a folder on a branch a link opened.
  case files(FilePlace)
  case inspect(String)

  var id: Self { self }
}

/// The file or the folder a link in Chat opened, with a stack of its own for what it opens in
/// turn, both kept in the model, so a fold keeps what it shows. No button: it only shows a file, so
/// a drag down closes it; a link to something Chat opens closes it too.
struct FileSheet: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if let browse = model.browsing {
      NavigationStack(
        path: Binding(
          get: { model.browsing?.path ?? [] },
          set: { model.browsing?.path = $0 })
      ) {
        BranchFileView(place: browse.root, open: { push($0) }, opened: { close() })
          .navigationDestination(for: BoardPlace.self) { place in
            if case .files(let file) = place {
              BranchFileView(place: file, open: { push($0) }, opened: { close() })
            }
          }
      }
    }
  }

  private func push(_ place: FilePlace) {
    model.browsing?.path.append(.files(place))
  }

  private func close() {
    model.browsing = nil
  }
}

/// A task's plan or a proposal's charter on a stack of its own, which the plan pushes a file's
/// change and the branch's files on, kept in the model by task, so a fold that moves the plan
/// between its column and its sheet keeps what it shows. Only the stack where the plan shows now,
/// beside the thread or in the sheet as Chat last settled it, writes to the model: one a fold takes
/// away writes nothing as it goes.
struct SubjectStack: View {
  @Environment(AppModel.self) private var model
  let subject: Subject
  fileprivate let placement: PlanPlacement
  /// Whether this is the stack in the column beside the thread.
  let beside: Bool

  var body: some View {
    let id = subject.id
    NavigationStack(
      path: Binding(
        get: { model.planPaths[id] ?? [] },
        set: { path in
          if placement.beside == beside, model.inspecting == id {
            model.planPaths[id] = path.isEmpty ? nil : path
          }
        })
    ) {
      SubjectDetail(subject: subject)
        .navigationTitle(subject.isTask ? "Plan" : "Charter")
        .navigationBarTitleDisplayMode(.inline)
        .containerBackground(MessageColor.island, for: .navigation)
        .navigationDestination(for: BoardPlace.self) { place in
          switch place {
          case .change(let task, let path):
            ChangeView(taskId: task, path: path) { model.push(.files($0), onPlanOf: id) }
          case .files(let file):
            BranchFileView(
              place: file, open: { model.push(.files($0), onPlanOf: id) },
              opened: { model.inspecting = nil })
          case .project(let slug):
            ProjectView(slug: slug)
          }
        }
    }
  }
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
