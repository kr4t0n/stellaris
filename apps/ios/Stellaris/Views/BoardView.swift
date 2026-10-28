import BoardKit
import SwiftUI

/// The board's places: the society's channels, then each project's dashboard and tasks, channels,
/// and tasks in play. Picking a channel or a task opens it in Chat; a project's dashboard and tasks
/// open here, kept in the model as the place Board shows.
struct BoardView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var model = model
    NavigationStack(path: $model.boardPath) {
      List {
        Section("Society") {
          ForEach(model.store.societyChannels, id: \.ref) { channel in
            ChannelRow(channel: channel)
          }
        }
        ForEach(model.store.openProjects, id: \.slug) { project in
          Section(project.name) {
            NavigationLink(value: project.slug) {
              Label("Dashboard and tasks", systemImage: "rectangle.grid.1x2")
            }
            .accessibilityIdentifier("project-\(project.slug)")
            ForEach(model.store.channels(of: project.slug), id: \.ref) { channel in
              ChannelRow(channel: channel)
            }
            ForEach(model.store.tasksInPlay(of: project.slug)) { task in
              TaskRow(task: task)
            }
          }
        }
      }
      .overlay {
        BoardState(
          state: model.store.state,
          rows: !model.store.societyChannels.isEmpty || !model.store.openProjects.isEmpty,
          empty: nil)
      }
      .refreshable { await model.refresh() }
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button {
            model.showsSettings = true
          } label: {
            Label("Settings", systemImage: "gearshape")
          }
          .accessibilityIdentifier("settings")
        }
      }
      .navigationDestination(for: String.self) { slug in
        ProjectView(slug: slug)
      }
    }
  }
}

private struct ChannelRow: View {
  @Environment(AppModel.self) private var model
  let channel: ChannelSummary

  var body: some View {
    Button {
      model.open(.channel(channel.ref))
    } label: {
      LabeledContent {
        if channel.messages > 0 {
          Text(channel.messages, format: .number)
        }
      } label: {
        Label {
          Text(channel.name)
            .lineLimit(1)
            .truncationMode(.middle)
        } icon: {
          Image(systemName: "number")
        }
      }
    }
    .foregroundStyle(.primary)
    .accessibilityIdentifier("channel-\(channel.ref)")
  }
}

struct TaskRow: View {
  @Environment(AppModel.self) private var model
  let task: BoardTask
  /// Whether the row draws the task's plan as segments, as the web's tasks view does, as it does
  /// in a project's list, whose rows are named apart from Board's own.
  var plan = false

  var body: some View {
    Button {
      model.open(.thread(task.id))
    } label: {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(task.title)
            .lineLimit(2)
          Text(line)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          if plan {
            PlanSegments(task: task)
              .padding(.top, 4)
          }
        }
      } icon: {
        Image(systemName: "checklist")
      }
    }
    .foregroundStyle(.primary)
    .accessibilityIdentifier("\(plan ? "project-task" : "task")-\(task.id)")
  }

  /// The stage the task is at, or how far it came.
  private var line: String {
    task.currentStage.map { "\(task.progress) · \($0.name)" } ?? task.progress
  }
}

/// A project as Board shows it: its dashboard, then its tasks grouped by where they stand, each
/// group last updated first, as the web's project and tasks views list them. Picking a task opens
/// it in Chat. At the accessibility sizes the list is plain and the dashboard's row narrowly inset,
/// since a grouped list's margins leave a dashboard's words too little room on a narrow window and
/// break them mid-word.
struct ProjectView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dynamicTypeSize) private var typeSize
  let slug: String

  var body: some View {
    let groups = groupTasks(model.store.tasks(of: slug))
    List {
      Section("Dashboard") {
        dashboard
          .listRowInsets(
            typeSize.isAccessibilitySize
              ? EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8) : nil)
      }
      ForEach(groups) { group in
        Section("\(group.phase.label) · \(group.tasks.count)") {
          ForEach(group.tasks) { task in
            TaskRow(task: task, plan: true)
          }
        }
      }
      if groups.isEmpty, model.store.state == .loaded {
        Section("Tasks") {
          Text("No tasks")
            .foregroundStyle(.secondary)
        }
      }
    }
    .modifier(ProjectListStyle(plain: typeSize.isAccessibilitySize))
    .navigationTitle(model.store.projectName(slug))
    .refreshable {
      await model.store.loadDashboard(slug, using: model)
      await model.refresh()
    }
    .task(id: slug) {
      await model.store.loadDashboard(slug, using: model)
    }
    .modifier(FollowsBoardLinks())
  }

  /// The dashboard's text, read as a message is, or how its read stands.
  @ViewBuilder private var dashboard: some View {
    if let page = model.store.dashboards[slug] {
      let text = page.body.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty {
        Text("No dashboard yet")
          .foregroundStyle(.secondary)
      } else {
        MessageBody(document: model.document(id: "dashboard:\(slug)", markdown: page.body))
          .accessibilityIdentifier("dashboard-\(slug)")
      }
    } else {
      switch model.store.dashboardStates[slug] ?? .idle {
      case .failed(let reason):
        Label(reason, systemImage: "wifi.exclamationmark")
          .foregroundStyle(.secondary)
        Button("Retry") {
          Task { await model.store.loadDashboard(slug, using: model) }
        }
      case .idle, .loading, .loaded:
        ProgressView()
      }
    }
  }
}

/// What a list of the board shows while it loads, when it fails, or when it is empty: nothing once
/// it has rows, which a refresh that fails leaves as they were, as a conversation does its messages.
struct BoardState: View {
  @Environment(AppModel.self) private var model
  let state: Loading
  /// Whether the list has rows.
  let rows: Bool
  /// The empty state's words, for a list that can be empty.
  let empty: String?

  var body: some View {
    if !rows {
      switch state {
      case .idle, .loading:
        ProgressView()
      case .loaded:
        if let empty {
          ContentUnavailableView(empty, systemImage: "checkmark.circle")
        }
      case .failed(let reason):
        ContentUnavailableView {
          Label(reason, systemImage: "wifi.exclamationmark")
        } actions: {
          Button("Retry") {
            Task { await model.refresh() }
          }
        }
      }
    }
  }
}

/// A project's list: grouped as Board's is, but plain where `plain` is set.
private struct ProjectListStyle: ViewModifier {
  let plain: Bool

  func body(content: Content) -> some View {
    if plain {
      content.listStyle(.plain)
    } else {
      content.listStyle(.insetGrouped)
    }
  }
}
