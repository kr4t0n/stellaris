// A branch's files as the web shows them, a port of `byName`, `entriesInOrder`, `sizeLabel`,
// `imageType`, `textOf`, `viewOf`, `parseDelimited`, `fileLines`, `parentOf`, and `runnerOf` in the
// web's `apps/web/src/lib/files.ts`, with its `TABLE_ROWS` and `NUMBERED_LINES`. Both run the case
// table `apps/ios/fixtures/cases/files.json`. Names compare by UTF-16 code units and text is read
// scalar by scalar, as the web's strings are, never by Swift's characters, which take CRLF as one
// and a decomposed accent as equal to the composed one.

import Foundation

/// Rows of a table shown at once, as the web's `TABLE_ROWS`; a longer one says how many it has.
public let fileTableRows = 1000
/// Lines of text numbered one by one, as the web's `NUMBERED_LINES`; a longer file shows as plain
/// text.
public let fileNumberedLines = 20_000
/// The largest file a branch read carries, as the board's `BRANCH_FILE_LIMIT_BYTES`; a larger one
/// comes with its size alone.
public let branchFileLimitBytes = 8 * 1024 * 1024

/// Two strings by their UTF-16 code units, as JavaScript's `<` compares them: -1, 0, or 1.
private func compareUnits(_ a: String, _ b: String) -> Int {
  var left = a.utf16.makeIterator()
  var right = b.utf16.makeIterator()
  while true {
    switch (left.next(), right.next()) {
    case (nil, nil): return 0
    case (nil, _): return -1
    case (_, nil): return 1
    case (let one?, let other?):
      if one != other {
        return one < other ? -1 : 1
      }
    }
  }
}

/// The name with the letters A to Z read as a to z, and nothing else changed.
private func folded(_ name: String) -> String {
  var scalars = String.UnicodeScalarView()
  for scalar in name.unicodeScalars {
    scalars.append(
      ("A"..."Z").contains(scalar) ? Unicode.Scalar(scalar.value + 32) ?? scalar : scalar)
  }
  return String(scalars)
}

/// Two names in the order a listing shows them: with the letters A to Z read as a to z, then by
/// UTF-16 code units, the same in every locale. -1, 0, or 1, as the web's `byName`.
public func byName(_ a: String, _ b: String) -> Int {
  let byFold = compareUnits(folded(a), folded(b))
  return byFold != 0 ? byFold : compareUnits(a, b)
}

/// A folder's entries as a listing shows them: folders first, then files, each by name.
public func entriesInOrder(_ entries: [BranchEntry]) -> [BranchEntry] {
  entries.sorted { a, b in
    let folder = (a.kind == .known(.dir), b.kind == .known(.dir))
    return folder.0 == folder.1 ? byName(a.name, b.name) < 0 : folder.0
  }
}

/// `bytes` over `per`, in tenths, the nearest, a tie rounded up, as `toFixed(1)` rounds the exact
/// value a division by a power of two gives.
private func tenths(_ bytes: Int, per: Int) -> Int {
  (bytes * 20 + per) / (2 * per)
}

/// A size as "812 B", "4.2 KB", or "3.1 MB".
public func sizeLabel(_ bytes: Int) -> String {
  if bytes < 1024 {
    return "\(bytes) B"
  }
  let (count, unit) =
    bytes < 1024 * 1024 ? (tenths(bytes, per: 1024), "KB") : (tenths(bytes, per: 1024 * 1024), "MB")
  return "\(count / 10).\(count % 10) \(unit)"
}

/// What follows the last `scalar` in `text`, or nil when it holds none.
private func after(last scalar: Unicode.Scalar, in text: String) -> (before: String, after: String)? {
  let scalars = text.unicodeScalars
  guard let at = scalars.lastIndex(of: scalar) else {
    return nil
  }
  return (String(scalars[..<at]), String(scalars[scalars.index(after: at)...]))
}

/// A file's extension, lower-cased: none for a name with no dot, or one that starts with its only
/// dot, as `.gitignore` does.
private func extensionOf(_ path: String) -> String {
  let name = after(last: "/", in: path)?.after ?? path
  guard let split = after(last: ".", in: name), !split.before.isEmpty else {
    return ""
  }
  return split.after.lowercased()
}

private let imageTypes = [
  "png": "image/png",
  "jpg": "image/jpeg",
  "jpeg": "image/jpeg",
  "gif": "image/gif",
  "webp": "image/webp",
  "avif": "image/avif",
  "bmp": "image/bmp",
  "ico": "image/x-icon",
  "svg": "image/svg+xml",
]

/// The media type an image file is shown with, or nil for a file that is not an image.
public func imageType(_ path: String) -> String? {
  imageTypes[extensionOf(path)]
}

/// The bytes as text, or nil when they aren't UTF-8 or hold a NUL, as binary files do. A leading
/// byte-order mark is dropped, as the web's `TextDecoder` drops it.
public func textOf(_ data: Data) -> String? {
  let bytes = data.starts(with: [0xEF, 0xBB, 0xBF]) ? data.dropFirst(3) : data[...]
  guard let text = String(validating: bytes, as: UTF8.self), !text.unicodeScalars.contains("\0")
  else {
    return nil
  }
  return text
}

/// How a file's content is shown, chosen by its name and then by whether it reads as text.
public enum FileView: Sendable, Hashable {
  case markdown(String)
  /// An image, with its media type.
  case image(String)
  /// A CSV or TSV file's rows.
  case table([[String]])
  case text(String)
  case binary
}

public func viewOf(_ path: String, _ data: Data) -> FileView {
  if let type = imageType(path) {
    return .image(type)
  }
  guard let text = textOf(data) else {
    return .binary
  }
  switch extensionOf(path) {
  case "md", "markdown": return .markdown(text)
  case "csv": return .table(parseDelimited(text, separator: ","))
  case "tsv": return .table(parseDelimited(text, separator: "\t"))
  default: return .text(text)
  }
}

/// Rows of a CSV or TSV file. Quoted fields may hold separators, line breaks, and doubled quotes;
/// rows may differ in length.
public func parseDelimited(_ text: String, separator: Unicode.Scalar) -> [[String]] {
  let scalars = Array(text.unicodeScalars)
  var rows: [[String]] = []
  var row: [String] = []
  var field = String.UnicodeScalarView()
  var quoted = false
  var at = 0
  while at < scalars.count {
    let char = scalars[at]
    let next = at + 1 < scalars.count ? scalars[at + 1] : nil
    if quoted {
      if char != "\"" {
        field.append(char)
      } else if next == "\"" {
        field.append("\"")
        at += 1
      } else {
        quoted = false
      }
    } else if char == "\"", field.isEmpty {
      quoted = true
    } else if char == separator {
      row.append(String(field))
      field = String.UnicodeScalarView()
    } else if char == "\n" || char == "\r" {
      if char == "\r", next == "\n" {
        at += 1
      }
      row.append(String(field))
      rows.append(row)
      row = []
      field = String.UnicodeScalarView()
    } else {
      field.append(char)
    }
    at += 1
  }
  if !field.isEmpty || !row.isEmpty {
    row.append(String(field))
    rows.append(row)
  }
  return rows
}

/// A text file's lines as its view numbers them, split at each LF, a last one ending the file.
public func fileLines(_ text: String) -> [String] {
  var scalars = text.unicodeScalars
  if scalars.last == "\n" {
    scalars.removeLast()
  }
  return scalars.split(separator: "\n", omittingEmptySubsequences: false).map {
    String(String.UnicodeScalarView($0))
  }
}

/// The folder a path on a branch sits in, empty at the root.
public func parentOf(_ path: String) -> String {
  after(last: "/", in: path)?.before ?? ""
}

/// The runner a project lives on, named for a view to say it is away: "runner-1, the runner Lab
/// lives on".
public func runnerOf(runner: String?, name: String?) -> String {
  "\(runner.map { "\($0), the runner" } ?? "The runner") \(name ?? "the project") lives on"
}

public func runnerOf(_ project: Project?) -> String {
  runnerOf(runner: project?.runner, name: project?.name)
}

/// A file or a folder on a task's branch or a project's default branch, at the line a link cites.
public struct FilePlace: Sendable, Hashable {
  public let source: FileSource
  /// The path on the branch, empty for its root.
  public let path: String
  public let line: Int?

  public init(source: FileSource, path: String, line: Int? = nil) {
    self.source = source
    self.path = path
    self.line = line
  }

  /// The name a view of it shows: its last segment, or Files at the branch's root.
  public var name: String {
    path.isEmpty ? "Files" : after(last: "/", in: path)?.after ?? path
  }

  /// Where the web shows it: `/task/<id>/files/<path>`, or `/p/<slug>/files/<path>` for a project,
  /// with the line as `?line=`. Each segment is encoded, so a `?` or a `#` in a name stays in it.
  public var href: String {
    let place =
      switch source {
      case .task(let id): "/task/\(id)/files"
      case .project(let slug): "/p/\(slug)/files"
      }
    let segments = path.split(separator: "/").map {
      "/" + ($0.addingPercentEncoding(withAllowedCharacters: segmentAllowed) ?? String($0))
    }
    return place + segments.joined() + (line.map { "?line=\($0)" } ?? "")
  }

  /// The place an address on the board names, as `href` writes it; nil for any other address, a
  /// path that climbs out of its branch, or an encoding that doesn't decode.
  public init?(href: String) {
    let parts = href.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    let route = parts.first.map(String.init) ?? ""
    let source: FileSource
    let rest: Substring
    if let match = route.wholeMatch(of: taskFiles) {
      source = .task(String(match.1))
      rest = match.2
    } else if let match = route.wholeMatch(of: projectFiles) {
      source = .project(String(match.1))
      rest = match.2
    } else {
      return nil
    }
    var segments: [String] = []
    for segment in rest.split(separator: "/") {
      guard let decoded = segment.removingPercentEncoding, !decoded.isEmpty,
        !decoded.unicodeScalars.contains("/")
      else {
        return nil
      }
      segments.append(decoded)
    }
    let path = segments.joined(separator: "/")
    guard let inside = normalizePath(path), inside == path else {
      return nil
    }
    let query = parts.count > 1 ? String(parts[1]) : ""
    let line = query.split(separator: "&").lazy.compactMap { pair -> Int? in
      let field = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard field.count == 2, field[0] == "line", let line = Int(field[1]), line > 0 else {
        return nil
      }
      return line
    }.first
    self.init(source: source, path: inside, line: line)
  }
}

/// What a segment of a path keeps as written: the path's characters but `/`, `?`, `#`, and `%`.
private let segmentAllowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))

// A task's files and a project's: the web's `/task/$taskId/files/$` and `/p/$slug/files/$`.
nonisolated(unsafe) private let taskFiles = #/\/task\/([0-9A-HJKMNP-TV-Z]{26})\/files((?:\/[^\/]+)*)/#
nonisolated(unsafe) private let projectFiles = #/\/p\/([a-z0-9][a-z0-9-]{0,31})\/files((?:\/[^\/]+)*)/#

// MARK: A task's changes

/// What a branch did to a file, in a word and its line counts, as the web's `changeLabel`: "new ·
/// +40", "+3 −1", "deleted". A status this client doesn't know leads with its own word, "renamed ·
/// +3 −1".
public func changeLabel(_ change: BranchFileChange) -> String {
  changeLabel(status: change.status, added: change.added, removed: change.removed)
}

public func changeLabel(status: OrUnknown<BranchFileChange.Status>, added: Int?, removed: Int?)
  -> String
{
  if status == .known(.deleted) {
    return "deleted"
  }
  let lines =
    if let added, let removed {
      status == .known(.added) ? "+\(added)" : "+\(added) −\(removed)"
    } else {
      "binary"
    }
  switch status {
  case .known(.added): return "new · \(lines)"
  case .unknown(let word): return "\(word) · \(lines)"
  default: return lines
  }
}

/// One line of a patch, with its number in the file on the branch for a line the file still has.
public struct PatchRow: Sendable, Hashable {
  public enum Kind: String, Sendable, Hashable {
    case hunk, added, removed, context, note
  }

  public let kind: Kind
  public let text: String
  public let line: Int?

  public init(kind: Kind, text: String, line: Int? = nil) {
    self.kind = kind
    self.text = text
    self.line = line
  }
}

/// A patch's hunks as rows, each added or unchanged line numbered from its hunk's header, as the
/// web's `patchRows`. Lines split at each LF and are told apart by their first scalar, as the web's
/// strings are, never by Swift's characters, which take CRLF as one and a mark after a `-` as part
/// of it.
public func patchRows(_ patch: String) -> [PatchRow] {
  if patch.isEmpty {
    return []
  }
  var next = 0
  return patch.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map {
    scalars in
    let text = String(String.UnicodeScalarView(scalars))
    if let start = hunkStart(Array(scalars)) {
      next = start
      return PatchRow(kind: .hunk, text: text)
    }
    switch scalars.first {
    case "-":
      return PatchRow(kind: .removed, text: text)
    // "\ No newline at end of file" belongs to the line before it.
    case "\\":
      return PatchRow(kind: .note, text: text)
    default:
      let line = next
      next &+= 1
      return PatchRow(kind: scalars.first == "+" ? .added : .context, text: text, line: line)
    }
  }
}

/// The first line a hunk's header gives the file on the branch, as `@@ -1,3 +12,4 @@` gives 12,
/// or nil for a line that isn't a header: `^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@`, with `\d` the
/// ASCII digits, as JavaScript reads it.
private func hunkStart(_ line: [Unicode.Scalar]) -> Int? {
  var at = 0
  func take(_ literal: String) -> Bool {
    for scalar in literal.unicodeScalars {
      guard at < line.count, line[at] == scalar else {
        return false
      }
      at += 1
    }
    return true
  }
  func digits() -> String? {
    let start = at
    while at < line.count, ("0"..."9").contains(line[at]) {
      at += 1
    }
    return at > start ? String(String.UnicodeScalarView(line[start..<at])) : nil
  }
  func count() -> Bool {
    let start = at
    if take(","), digits() == nil {
      at = start
      return false
    }
    return true
  }
  guard take("@@ -"), digits() != nil else {
    return nil
  }
  // An optional count, which a comma without digits after it isn't.
  let afterOld = at
  if !count() {
    at = afterOld
  }
  guard take(" +"), let start = digits() else {
    return nil
  }
  let afterNew = at
  if !count() {
    at = afterNew
  }
  guard take(" @@") else {
    return nil
  }
  return Int(start) ?? 0
}

/// A file of a branch's changes in the tree, by its name in its folder.
public struct TreeFile: Sendable, Hashable {
  public let name: String
  public let change: BranchFileChange
}

/// A folder of a branch's changes: `name` may span several folders, `a/b`, where each held
/// nothing but the next. `files` counts every file under it, and `lastChange` is the newest among
/// them.
public struct TreeFolder: Sendable, Hashable {
  public let name: String
  public let path: String
  public let children: [TreeNode]
  public let files: Int
  public let lastChange: BranchFileChange.Touch?
}

public enum TreeNode: Sendable, Hashable {
  case dir(TreeFolder)
  case file(TreeFile)
}

/// A folder of the tree as it is built, its folders by their names' UTF-16 code units, so two
/// names Swift takes as equal, a composed accent and a decomposed one, stay two folders, as they
/// are on the web.
private final class Building {
  let name: String
  let path: String
  var folders: [[UInt16]: Building] = [:]
  var files: [TreeFile] = []

  init(name: String, path: String) {
    self.name = name
    self.path = path
  }

  func finish() -> TreeFolder {
    let folders = self.folders.values.map { $0.finish() }.sorted { byName($0.name, $1.name) < 0 }
    var children =
      folders.map(TreeNode.dir) + files.sorted { byName($0.name, $1.name) < 0 }.map(TreeNode.file)
    var name = self.name
    var path = self.path
    // A folder that holds only one folder reads as one row, as a code host's file tree shows it.
    if !self.path.isEmpty, children.count == 1, case .dir(let only)? = children.first {
      name = "\(name)/\(only.name)"
      path = only.path
      children = only.children
    }
    var files = 0
    var lastChange: BranchFileChange.Touch?
    for child in children {
      let last: BranchFileChange.Touch?
      switch child {
      case .dir(let folder):
        files += folder.files
        last = folder.lastChange
      case .file(let file):
        files += 1
        last = file.change.lastChange
      }
      if let last, lastChange.map({ compareUnits(last.at, $0.at) > 0 }) ?? true {
        lastChange = last
      }
    }
    return TreeFolder(
      name: name, path: path, children: children, files: files, lastChange: lastChange)
  }
}

/// A branch's changed files as a tree of folders, folders before files and each by name, as the
/// web's `fileTree`.
public func fileTree(_ changes: [BranchFileChange]) -> TreeFolder {
  let root = Building(name: "", path: "")
  for change in changes {
    let parts = change.path.unicodeScalars.split(separator: "/", omittingEmptySubsequences: false)
      .map { String(String.UnicodeScalarView($0)) }
    var folder = root
    for part in parts.dropLast() {
      let key = Array(part.utf16)
      if let next = folder.folders[key] {
        folder = next
      } else {
        let next = Building(name: part, path: folder.path.isEmpty ? part : "\(folder.path)/\(part)")
        folder.folders[key] = next
        folder = next
      }
    }
    folder.files.append(TreeFile(name: parts.last ?? change.path, change: change))
  }
  return root.finish()
}

/// The folders a tree opens with, as the web's `openFolders`: shallowest first, each opened while
/// the rows it adds keep the view within `rows`, so a small change shows whole and a large one shows
/// its shape, with its biggest folders closed. In the order they opened.
public func openFolders(_ root: TreeFolder, rows: Int = 24) -> [String] {
  func folders(_ nodes: [TreeNode]) -> [TreeFolder] {
    nodes.compactMap { node in
      if case .dir(let folder) = node { folder } else { nil }
    }
  }
  var open: [String] = []
  var shown = root.children.count
  var queue = folders(root.children)
  var at = 0
  while at < queue.count {
    let folder = queue[at]
    at += 1
    if shown + folder.children.count > rows {
      continue
    }
    open.append(folder.path)
    shown += folder.children.count
    queue.append(contentsOf: folders(folder.children))
  }
  return open
}
