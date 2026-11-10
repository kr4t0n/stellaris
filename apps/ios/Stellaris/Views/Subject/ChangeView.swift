import BoardKit
import SwiftUI

/// What a task's branch did to one file, as the web opens it under the file's row: what happened
/// to it and whose turn touched it last, then its patch, removed lines red and added ones green,
/// each line the file still has numbered as the branch has it, a number opening the whole file at
/// that line with `open`, and Whole file in the bar while the branch has the file. It takes the
/// width of the stack it is pushed on, since a phone's row is too narrow for a patch.
struct ChangeView: View {
  @Environment(AppModel.self) private var model
  let taskId: String
  let path: String
  let open: (FilePlace) -> Void

  var body: some View {
    let key = ChangeKey(task: taskId, path: path)
    TimelineView(.everyMinute) { context in
      content(now: context.date)
    }
    .background(MessageColor.island)
    .navigationTitle(FilePlace(source: .task(taskId), path: path).name)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if !deleted {
        ToolbarItem(placement: .primaryAction) {
          Button {
            open(FilePlace(source: .task(taskId), path: path))
          } label: {
            Label("Whole file", systemImage: "doc.text")
          }
          .accessibilityIdentifier("whole-file")
        }
      }
    }
    .task { await model.store.loadTaskDiff(key, using: model) }
    .onAppear { model.store.showingDiff(key, true) }
    .onDisappear { model.store.showingDiff(key, false) }
  }

  /// The change as the list of the task's changes gives it.
  private var change: BranchFileChange? {
    model.store.taskChanges[taskId]?.changes.files.first { $0.path == path }
  }

  /// Whether the branch deleted the file, which leaves no whole file to open.
  private var deleted: Bool {
    let status = model.store.taskDiffs[ChangeKey(task: taskId, path: path)]?.diff.status
      ?? change?.status
    return status == .known(.deleted)
  }

  private func content(now: Date) -> some View {
    let key = ChangeKey(task: taskId, path: path)
    return ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text(heading(now: now))
          .font(MessageType.small())
          .foregroundStyle(MessageColor.tertiary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("change-heading")
        if let shown = model.store.taskDiffs[key] {
          if shown.diff.patch == nil {
            Words(words: "A binary file; its contents are not shown here.")
          } else if shown.rows.isEmpty {
            Words(words: "No lines changed.")
          } else {
            PatchLines(rows: shown.rows) { line in
              open(FilePlace(source: .task(taskId), path: path, line: line))
            }
            if shown.diff.truncated {
              Words(words: "The rest of this file's change is cut.")
            }
          }
        } else {
          switch model.store.taskDiffStates[key] ?? .loading {
          case .away:
            Words(words: "The task's runner is not connected, so the change cannot be read now.")
            retry(key)
          case .failed(let reason):
            Words(words: reason)
            retry(key)
          case .loading, .loaded:
            Words(words: "Reading the change…")
          }
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .refreshable { await model.store.loadTaskDiff(key, using: model) }
  }

  /// Where the file is, what happened to it, and whose turn touched it last: "src/export/view.ts ·
  /// +4 −2 · rev-1 3 hours ago".
  private func heading(now: Date) -> String {
    var line = path
    if let change {
      line += " · \(changeLabel(change))"
      if let last = change.lastChange {
        line += " · \(model.displayName(last.author)) \(BoardTime.ago(last.at, now: now))"
      }
    }
    return line
  }

  /// Retry, since on a phone nothing else reads the change again while it shows.
  private func retry(_ key: ChangeKey) -> some View {
    Button("Retry") {
      Task { await model.store.loadTaskDiff(key, using: model) }
    }
    .font(MessageType.small())
  }
}

/// How the change stands where there are no lines to show, in the web's words.
private struct Words: View {
  let words: String

  var body: some View {
    Text(words)
      .font(MessageType.small())
      .foregroundStyle(MessageColor.tertiary)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier("change-state")
  }
}

/// A patch's rows on the code's ground: hunks' headers and notes muted, removed lines red, added
/// ones green, the rest as they are, each long line wrapping as the web's does, and each line the
/// file still has numbered, the number a button that opens the file at that line.
private struct PatchLines: View {
  let rows: [PatchRow]
  let open: (Int) -> Void

  var body: some View {
    // The widest number, in the numbers' own font, sizes the gutter, so no number breaks onto a
    // second line at any type size.
    let widest = String(repeating: "8", count: String(rows.compactMap(\.line).max() ?? 0).count)
    LazyVStack(alignment: .leading, spacing: 0) {
      ForEach(rows.indices, id: \.self) { index in
        row(rows[index], widest: widest)
      }
    }
    .padding(.vertical, 6)
    .background(MessageColor.surface0.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
    .accessibilityIdentifier("patch")
  }

  private func row(_ row: PatchRow, widest: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      ZStack(alignment: .trailing) {
        Text(widest).hidden()
        if let line = row.line {
          Button {
            open(line)
          } label: {
            Text("\(line)")
              .foregroundStyle(MessageColor.muted)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Open at line \(line)")
          .accessibilityIdentifier("patch-line-\(line)")
        }
      }
      .fixedSize()
      Text(row.text.isEmpty ? " " : row.text)
        .foregroundStyle(PatchTone.text(row.kind))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .font(MessageType.code)
    .monospacedDigit()
    .padding(.horizontal, 8)
    .padding(.vertical, 1)
    .background(PatchTone.ground(row.kind))
  }
}

/// A patch row's colours, as the web's: emerald and red text over a tenth of their ground for
/// added and removed lines, Tailwind's red-500 standing in for the web's red-400 ground.
private enum PatchTone {
  static func text(_ kind: PatchRow.Kind) -> Color {
    switch kind {
    case .hunk, .note: MessageColor.muted
    case .added: Color(sky: MessageTheme.emerald300)
    case .removed: Color(sky: MessageTheme.red300)
    case .context: MessageColor.tertiary
    }
  }

  static func ground(_ kind: PatchRow.Kind) -> Color {
    switch kind {
    case .added: Color(sky: MessageTheme.emerald400, opacity: 0.1)
    case .removed: Color(sky: MessageTheme.red500, opacity: 0.1)
    case .hunk, .note, .context: .clear
    }
  }
}
