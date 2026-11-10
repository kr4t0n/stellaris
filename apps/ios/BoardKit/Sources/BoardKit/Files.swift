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
