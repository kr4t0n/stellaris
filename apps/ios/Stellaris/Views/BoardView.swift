import BoardKit
import SwiftUI

/// The board's places: the society's channels, then each project's channels and tasks in play.
/// Picking one opens it in Chat.
struct BoardView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    NavigationStack {
      List {
        Section("Society") {
          ForEach(model.store.societyChannels, id: \.ref) { channel in
            ChannelRow(channel: channel)
          }
        }
        ForEach(model.store.openProjects, id: \.slug) { project in
          Section(project.name) {
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

private struct TaskRow: View {
  @Environment(AppModel.self) private var model
  let task: BoardTask

  var body: some View {
    Button {
      model.open(.thread(task.id))
    } label: {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(task.title)
            .lineLimit(2)
          if let stage = task.stages.first(where: { $0.id == task.stage }) {
            Text(stage.name)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      } icon: {
        Image(systemName: "checklist")
      }
    }
    .foregroundStyle(.primary)
    .accessibilityIdentifier("task-\(task.id)")
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
