import BoardKit
import SwiftUI

/// What a task's branch changed since it left the default branch, at the plan's end as the web's
/// task view shows it: how many files and whose commit is newest, then a tree of folders, each
/// opening in place, and files, each with what happened to it and whose turn touched it last,
/// pushing its change on the plan's stack. Browse the branch pushes the branch's root there.
struct TaskFiles: View {
  @Environment(AppModel.self) private var model
  let task: BoardTask
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        SectionTitle("Files")
        Spacer(minLength: 0)
        Button {
          model.push(.files(FilePlace(source: .task(task.id), path: "")), onPlanOf: task.id)
        } label: {
          Text("Browse the branch")
            .font(MessageType.small())
            .foregroundStyle(MessageColor.secondary)
            .underline()
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("browse-branch")
      }
      content
    }
    .task { await model.store.loadTaskChanges(task.id, using: model) }
    .onAppear { model.store.showingChanges(task.id, true) }
    .onDisappear { model.store.showingChanges(task.id, false) }
  }

  @ViewBuilder private var content: some View {
    let branch = "task/\(task.id)"
    if let shown = model.store.taskChanges[task.id] {
      let changes = shown.changes
      if changes.files.isEmpty {
        StateWords(words: "Nothing changed on \(branch) yet.")
      } else {
        let count = changes.total == 1 ? "1 file" : "\(changes.total) files"
        Text(
          "\(count) changed · newest commit by \(model.displayName(changes.head.author)) \(BoardTime.ago(changes.head.at, now: now))"
        )
        .font(MessageType.small())
        .foregroundStyle(MessageColor.tertiary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("changes-count")
        VStack(alignment: .leading, spacing: 0) {
          ForEach(rows(shown)) { row in
            switch row.node {
            case .dir(let folder):
              FolderRow(
                folder: folder, depth: row.depth,
                open: model.isOpen(folder.path, of: task.id, opened: shown.opened), now: now
              ) {
                model.toggle(folder.path, of: task.id, opened: shown.opened)
              }
            case .file(let file):
              ChangeRow(file: file, depth: row.depth, now: now) {
                model.push(.change(task: task.id, path: file.change.path), onPlanOf: task.id)
              }
            }
          }
        }
        if changes.total > changes.files.count {
          Text("The first \(changes.files.count) of \(changes.total)")
            .font(MessageType.small())
            .foregroundStyle(MessageColor.tertiary)
            .accessibilityIdentifier("changes-limit")
        }
      }
    } else {
      switch model.store.taskChangeStates[task.id] ?? .loading {
      case .missing:
        StateWords(words: "Nothing on \(branch) yet.")
      case .away:
        StateWords(
          words:
            "\(runnerOf(runner: project?.runner, name: project?.name ?? task.project)), is not connected, so the task's files cannot be listed now."
        )
        retry
      case .failed(let reason):
        StateWords(words: reason)
        retry
      case .loading, .loaded:
        StateWords(words: "Reading the task's branch…")
      }
    }
  }

  /// Retry, since on a phone nothing else reads the changes again while the plan shows, where the
  /// web can reload its page.
  private var retry: some View {
    Button("Retry") {
      Task { await model.store.loadTaskChanges(task.id, using: model) }
    }
    .font(MessageType.small())
  }

  private var project: Project? {
    model.store.projects.first { $0.slug == task.project }
  }

  /// The tree's rows as it shows them: each folder, and what it holds while it is open.
  private func rows(_ shown: ShownChanges) -> [TreeRow] {
    var rows: [TreeRow] = []
    func add(_ nodes: [TreeNode], depth: Int) {
      for node in nodes {
        rows.append(TreeRow(node: node, depth: depth))
        if case .dir(let folder) = node,
          model.isOpen(folder.path, of: task.id, opened: shown.opened)
        {
          add(folder.children, depth: depth + 1)
        }
      }
    }
    add(shown.tree.children, depth: 0)
    return rows
  }
}

/// A row of the tree as it shows, at its depth.
private struct TreeRow: Identifiable {
  let node: TreeNode
  let depth: Int

  var id: String {
    switch node {
    case .dir(let folder): "dir:\(folder.path)"
    case .file(let file): "file:\(file.change.path)"
    }
  }
}

/// How a read of the changes stands while there is nothing to list.
private struct StateWords: View {
  let words: String

  var body: some View {
    Text(words)
      .font(MessageType.small())
      .foregroundStyle(MessageColor.tertiary)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier("changes-state")
  }
}

/// How far a row of the tree is indented at its depth, and the room a folder's arrow takes, which
/// a file's row keeps too, so names line up.
private enum TreeIndent {
  static let step: CGFloat = 14
  static let arrow: CGFloat = 12
}

/// A folder of the changes: its arrow, its name, how many files it holds, and who touched it last;
/// a tap opens or closes it in place.
private struct FolderRow: View {
  let folder: TreeFolder
  let depth: Int
  let open: Bool
  let now: Date
  let toggle: () -> Void

  var body: some View {
    Button(action: toggle) {
      TreeLine(depth: depth) {
        Image(systemName: "chevron.right")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(MessageColor.muted)
          .rotationEffect(.degrees(open ? 90 : 0))
          .frame(width: TreeIndent.arrow)
          .accessibilityHidden(true)
      } name: {
        Text("\(folder.name)/")
          .foregroundStyle(MessageColor.primary)
      } meta: {
        Text(folder.files == 1 ? "1 file" : "\(folder.files) files")
      } touched: {
        Touched(last: folder.lastChange, now: now)
      }
    }
    .buttonStyle(.plain)
    .accessibilityValue(open ? "open" : "closed")
    .accessibilityIdentifier("change-folder-\(folder.path)")
  }
}

/// A file of the changes: its name, struck through once deleted, what happened to it, and whose
/// turn touched it last; a tap pushes its change.
private struct ChangeRow: View {
  let file: TreeFile
  let depth: Int
  let now: Date
  let open: () -> Void

  var body: some View {
    let deleted = file.change.status == .known(.deleted)
    Button(action: open) {
      TreeLine(depth: depth) {
        Color.clear.frame(width: TreeIndent.arrow, height: 1)
      } name: {
        Text(file.name)
          .strikethrough(deleted)
          .foregroundStyle(deleted ? MessageColor.tertiary : MessageColor.secondary)
      } meta: {
        Text(changeLabel(file.change))
      } touched: {
        Touched(last: file.change.lastChange, now: now)
      }
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("change-\(file.change.path)")
  }
}

/// A row of the tree on one line, the name cut in the middle, as the web's; at the accessibility
/// sizes, where one line leaves the name no room, what happened and who touched it go under it.
private struct TreeLine<Lead: View, Name: View, Meta: View, Touch: View>: View {
  @Environment(\.dynamicTypeSize) private var typeSize
  let depth: Int
  @ViewBuilder let lead: () -> Lead
  @ViewBuilder let name: () -> Name
  @ViewBuilder let meta: () -> Meta
  @ViewBuilder let touched: () -> Touch

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      lead()
      if typeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 2) {
          name()
            .font(MessageType.small())
            .fixedSize(horizontal: false, vertical: true)
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            meta()
            touched()
          }
          .font(MessageType.small())
          .foregroundStyle(MessageColor.tertiary)
          .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      } else {
        name()
          .font(MessageType.small())
          .lineLimit(1)
          .truncationMode(.middle)
        meta()
          .font(MessageType.small())
          .foregroundStyle(MessageColor.tertiary)
          .lineLimit(1)
          .fixedSize()
        Spacer(minLength: 8)
        touched()
          .font(MessageType.small())
          .foregroundStyle(MessageColor.tertiary)
          .lineLimit(1)
          .fixedSize()
      }
    }
    .padding(.leading, CGFloat(depth) * TreeIndent.step)
    .padding(.vertical, 5)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
  }
}

/// Who touched a file or a folder last, and when.
private struct Touched: View {
  @Environment(AppModel.self) private var model
  let last: BranchFileChange.Touch?
  let now: Date

  var body: some View {
    if let last {
      Text("\(model.displayName(last.author)) \(BoardTime.ago(last.at, now: now))")
    }
  }
}
