import BoardKit
import SwiftUI
import UniformTypeIdentifiers

/// A file or a folder on a task's branch or a project's default branch, as the web's file view
/// shows it: where it is and the commit its branch is at, then a folder's entries, folders first,
/// each opening by a push, or a file by its kind: markdown read as a message is, an image a pinch
/// zooms, a table, or text with its lines numbered and the cited line marked, with Share for its
/// bytes. A link in markdown to a file beside it opens with `open`, on the stack the view is in,
/// and one to something Chat opens closes what the view sits in with `opened`.
struct BranchFileView: View {
  @Environment(AppModel.self) private var model
  let place: FilePlace
  let open: (FilePlace) -> Void
  var opened: () -> Void = {}

  var body: some View {
    let key = place.unlined
    TimelineView(.everyMinute) { context in
      content(now: context.date)
    }
    .background(MessageColor.island)
    .navigationTitle(place.name)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let file = model.store.branchFiles[key], file.kind == .known(.file), let data = file.data {
        ToolbarItem(placement: .primaryAction) {
          ShareLink(
            item: SharedFile(name: place.name, data: data), preview: SharePreview(place.name)
          ) {
            Label("Share", systemImage: "square.and.arrow.up")
          }
          .accessibilityIdentifier("share-file")
        }
      }
    }
    .task(id: key) {
      await model.store.loadBranchFile(key, using: model)
    }
    .onAppear { model.store.showing(key, true) }
    .onDisappear { model.store.showing(key, false) }
  }

  @ViewBuilder private func content(now: Date) -> some View {
    let key = place.unlined
    if let file = model.store.branchFiles[key] {
      if file.kind == .known(.dir) {
        folder(file, now: now)
      } else {
        FileContent(
          file: file, place: place, heading: heading(file.commit, now: now), open: open,
          opened: opened)
      }
    } else {
      switch model.store.branchFileStates[key] ?? .loading {
      case .missing:
        StateLine(words: missing)
      case .away:
        StateLine(
          words:
            "\(runnerOf(project)), is not connected, so the \(whose) files cannot be read now.")
      case .failed(let reason):
        VStack(spacing: 12) {
          StateLine(words: reason)
          Button("Retry") {
            Task { await model.store.loadBranchFile(key, using: model) }
          }
        }
      case .loading, .loaded:
        VStack(spacing: 12) {
          ProgressView()
          StateLine(words: "Reading \(place.name) from the \(whose) runner…")
        }
      }
    }
  }

  /// A folder's entries, folders first, each opening its own view, files with their sizes, under
  /// the commit the branch is at; an empty branch says so.
  private func folder(_ file: BranchFile, now: Date) -> some View {
    let entries = entriesInOrder(file.entries ?? [])
    return List {
      Section {
        ForEach(entries, id: \.name) { entry in
          let path = place.path.isEmpty ? entry.name : "\(place.path)/\(entry.name)"
          NavigationLink(value: BoardPlace.files(FilePlace(source: place.source, path: path))) {
            EntryRow(entry: entry)
          }
          .accessibilityIdentifier("file-\(path)")
          .islandRow()
        }
      } header: {
        Text(heading(file.commit, now: now))
          .font(MessageType.small())
          .foregroundStyle(MessageColor.tertiary)
          .textCase(nil)
          .accessibilityIdentifier("file-commit")
      }
    }
    .islandList()
    .overlay {
      if entries.isEmpty {
        StateLine(words: emptyBranch)
      }
    }
    .refreshable { await model.store.loadBranchFile(place, using: model) }
  }

  /// Where the file is and the commit its branch is at, as the web's file view's subtitle says it:
  /// "Demo · main · line 30 · committed by eng-1 3 hours ago · 4f2c9e1".
  private func heading(_ commit: BranchCommit, now: Date) -> String {
    let line = place.line.map { " · line \($0)" } ?? ""
    let when = BoardTime.ago(commit.at, now: now)
    return
      "\(whereFrom)\(line) · committed by \(model.displayName(commit.author)) \(when) · \(commit.id.prefix(7))"
  }

  /// The task's title, or the project's name and its default branch.
  private var whereFrom: String {
    switch place.source {
    case .task(let id): model.store.task(id)?.title ?? id
    case .project(let slug): project.map { "\($0.name) · \($0.defaultBranch)" } ?? slug
    }
  }

  /// The project whose runner reads the branch.
  private var project: Project? {
    let slug =
      switch place.source {
      case .task(let id): model.store.task(id)?.project
      case .project(let slug): slug
      }
    return model.store.projects.first { $0.slug == slug }
  }

  private var whose: String {
    switch place.source {
    case .task: "task's"
    case .project: "project's"
    }
  }

  /// The branch, as the views name it: `task/<id>`, or the project's default branch.
  private var branch: String {
    switch place.source {
    case .task(let id): "task/\(id)"
    case .project: project?.defaultBranch ?? "the default branch"
    }
  }

  /// What the board's 404 says, in the web's words.
  private var missing: String {
    switch place.source {
    case .task: "\(place.path.isEmpty ? "Nothing" : place.path) is not on \(branch) yet."
    case .project: place.path.isEmpty ? emptyBranch : "\(place.path) is not on \(branch)."
    }
  }

  private var emptyBranch: String { "Nothing on \(branch) yet." }
}

/// A folder's entry: its name, cut in the middle, with a folder's or a file's symbol, and a file's
/// size.
private struct EntryRow: View {
  let entry: BranchEntry

  var body: some View {
    LabeledContent {
      if let size = entry.size {
        Text(sizeLabel(size))
      }
    } label: {
      Label {
        Text(entry.name)
          .lineLimit(1)
          .truncationMode(.middle)
      } icon: {
        Image(systemName: entry.kind == .known(.dir) ? "folder" : "doc")
      }
    }
    .foregroundStyle(.primary)
  }
}

/// A file's content by its kind, under where it is and its branch's commit.
private struct FileContent: View {
  @Environment(AppModel.self) private var model
  let file: BranchFile
  let place: FilePlace
  let heading: String
  let open: (FilePlace) -> Void
  let opened: () -> Void

  var body: some View {
    let name = place.name
    if let data = file.data {
      switch viewOf(file.path, data) {
      case .markdown(let text):
        scrolling {
          MessageBody(
            document: model.document(
              id: "file:\(place.unlined.href)", markdown: text,
              base: FileBase(source: place.source, dir: parentOf(place.path))))
            .modifier(FollowsBoardLinks(opened: opened, files: open))
        }
      case .image:
        VStack(alignment: .leading, spacing: 0) {
          Heading(words: heading).padding(16)
          FileImage(data: data, name: name, size: file.size ?? data.count)
        }
      case .table(let rows):
        scrolling { FileTable(rows: rows) }
      case .text(let text):
        NumberedText(text: text, heading: heading, cited: place.line)
      case .binary:
        scrolling {
          Notice(words: "\(name) is not text (\(sizeLabel(file.size ?? data.count))).")
        }
      }
    } else {
      scrolling {
        let limit = sizeLabel(branchFileLimitBytes)
        Notice(
          words: "\(name) is \(sizeLabel(file.size ?? 0)), more than the \(limit) the board shows.")
      }
    }
  }

  /// `content` under the heading, scrolling down, and read again with a pull.
  private func scrolling<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Heading(words: heading)
        content()
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .refreshable { await model.store.loadBranchFile(place, using: model) }
  }
}

/// Where a file is and its branch's commit.
private struct Heading: View {
  let words: String

  var body: some View {
    Text(words)
      .font(MessageType.small())
      .foregroundStyle(MessageColor.tertiary)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier("file-commit")
  }
}

/// What a file is when the view can't show it, in the web's words.
private struct Notice: View {
  let words: String

  var body: some View {
    Text(words)
      .font(MessageType.text())
      .foregroundStyle(MessageColor.secondary)
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// How a read stands while there is no answer to show, centred in the view.
private struct StateLine: View {
  let words: String

  var body: some View {
    Text(words)
      .font(MessageType.text())
      .foregroundStyle(MessageColor.secondary)
      .multilineTextAlignment(.center)
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityIdentifier("file-state")
  }
}

/// A text file's lines, numbered, as the web numbers them, with the cited one marked and scrolled
/// to the middle once; past `fileNumberedLines` lines, the text as it is. Lines never wrap: the
/// text scrolls sideways.
private struct NumberedText: View {
  @ScaledMetric(relativeTo: .caption) private var digit: CGFloat = 7.5
  let text: String
  let heading: String
  let cited: Int?

  var body: some View {
    let lines = fileLines(text)
    VStack(alignment: .leading, spacing: 0) {
      Heading(words: heading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      ScrollViewReader { proxy in
        ScrollView([.vertical, .horizontal]) {
          if lines.count > fileNumberedLines {
            Text(text)
              .font(MessageType.code)
              .foregroundStyle(MessageColor.secondary)
              .fixedSize()
              .padding(16)
              .textSelection(.enabled)
          } else {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                row(number: index + 1, line: line, gutter: CGFloat(String(lines.count).count))
              }
            }
            .padding(.vertical, 12)
          }
        }
        .onAppear {
          if let cited {
            proxy.scrollTo(cited, anchor: .center)
          }
        }
      }
      .background(MessageColor.surface0.opacity(0.8))
      .accessibilityIdentifier("file-lines")
    }
  }

  private func row(number: Int, line: String, gutter: CGFloat) -> some View {
    let marked = number == cited
    return HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text("\(number)")
        .foregroundStyle(MessageColor.muted)
        .frame(width: gutter * digit + 4, alignment: .trailing)
        .accessibilityHidden(true)
      Text(line.isEmpty ? " " : line)
        .foregroundStyle(MessageColor.secondary)
        .fixedSize()
    }
    .font(MessageType.code)
    .monospacedDigit()
    .padding(.horizontal, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(marked ? MessageColor.markTint : .clear)
    .overlay(alignment: .leading) {
      if marked {
        Rectangle().fill(MessageColor.markBar).frame(width: 2)
      }
    }
    .id(number)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("line-\(number)")
    .accessibilityAddTraits(marked ? .isSelected : [])
  }
}

/// A CSV or TSV file's rows: the first as its head, then up to `fileTableRows` more, each cell
/// wrapping at 240 points, with the web's hairlines between cells, scrolling sideways when wider
/// than the view.
private struct FileTable: View {
  let rows: [[String]]

  var body: some View {
    if let head = rows.first {
      let rest = rows.dropFirst()
      VStack(alignment: .leading, spacing: 8) {
        ScrollView(.horizontal) {
          Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
              ForEach(Array(head.enumerated()), id: \.offset) { _, name in
                cell(name, head: true)
              }
            }
            ForEach(Array(rest.prefix(fileTableRows).enumerated()), id: \.offset) { _, row in
              GridRow {
                ForEach(Array(row.enumerated()), id: \.offset) { _, value in
                  cell(value, head: false)
                }
              }
            }
          }
        }
        if rest.count > fileTableRows {
          Text("The first \(fileTableRows) of \(rest.count) rows")
            .font(MessageType.small())
            .foregroundStyle(MessageColor.tertiary)
        }
      }
    } else {
      Notice(words: "The table is empty.")
    }
  }

  private func cell(_ value: String, head: Bool) -> some View {
    Text(value)
      .font(MessageType.small(head ? .medium : .regular))
      .foregroundStyle(head ? MessageColor.primary : MessageColor.secondary)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: 240, alignment: .leading)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .border(MessageColor.line, width: 1)
  }
}

/// An image file, fitted to the view, which a pinch or a double tap zooms; one the app can't draw,
/// as an SVG, says so.
private struct FileImage: View {
  let data: Data
  let name: String
  let size: Int
  @State private var image: UIImage?
  @State private var unreadable = false

  var body: some View {
    Group {
      if let image {
        ZoomableImage(image: image)
          .accessibilityElement()
          .accessibilityLabel(name)
          .accessibilityAddTraits(.isImage)
      } else if unreadable {
        Notice(words: "\(name) is an image the app can't draw (\(sizeLabel(size))).")
          .padding(16)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      } else {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .task(id: data) {
      do {
        image = try await BoardImages.decode(data)
      } catch {
        unreadable = true
      }
    }
  }
}

/// A file's bytes for the share sheet, under the file's own name, so Save to Files keeps it.
private struct SharedFile: Transferable, Sendable {
  let name: String
  let data: Data

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .data) { $0.data }
      .suggestedFileName { $0.name }
  }
}
