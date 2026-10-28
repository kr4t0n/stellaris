// Where a link or an image in the board's text goes, a port of `entityOfHref` and `entityHref` in
// the web's `apps/web/src/lib/entities.ts`, `linkTarget` in `apps/web/src/lib/files.ts`, and the
// web's `urlTransform` in `apps/web/src/components/Markdown.tsx`. Both run the case table
// `apps/ios/fixtures/cases/links.json`.

import Foundation

// The patterns are shared by every caller: a `Regex` isn't `Sendable`, but nothing changes one once
// it is made, and the program it compiles to on first use is cached atomically.

/// What a link to something on the board names: a task's, a proposal's, or a thread's view, a cron
/// in the crons view, or a message in its thread or channel.
public enum EntityKind: String, Sendable, Hashable, Codable {
  case task, proposal, thread, cron, message
}

/// What a link points at on the board, as the web's `entityOfHref` reads it. A message's link names
/// its thread, or else its channel, which the link opens.
public struct EntityLink: Sendable, Hashable {
  public let kind: EntityKind
  public let id: String
  public let channel: String?
  public let thread: String?

  public init(kind: EntityKind, id: String, channel: String? = nil, thread: String? = nil) {
    self.kind = kind
    self.id = id
    self.channel = channel
    self.thread = thread
  }
}

/// Whose files a link reads: a task's branch, or a project's default branch.
public enum FileSource: Sendable, Hashable {
  case task(String)
  case project(String)
}

/// Where relative links in a file resolve: the file's folder in its source.
public struct FileBase: Sendable, Hashable {
  public let source: FileSource
  public let dir: String

  public init(source: FileSource, dir: String) {
    self.source = source
    self.dir = dir
  }
}

/// What a link or an image in the board's text points at, when it isn't an address the browser
/// opens: a file on a branch, an image a citizen uploaded, or a place on a machine nothing on the
/// board can open.
public enum LinkTarget: Sendable, Hashable {
  case file(source: FileSource, path: String, line: Int?)
  case upload(String)
  case local
}

nonisolated(unsafe) private let ulid = #/[0-9A-HJKMNP-TV-Z]{26}/#

/// The id an `image:<id>` address names, or nil for any other address.
public func uploadedImageId(_ href: String) -> String? {
  guard href.hasPrefix("image:") else {
    return nil
  }
  let id = String(href.dropFirst("image:".count))
  return id.wholeMatch(of: ulid) == nil ? nil : id
}

/// Where an entity's view is, as the web's router spells it.
public func entityHref(_ entity: EntityLink) -> String {
  switch entity.kind {
  case .cron:
    return "/crons?cron=\(entity.id)"
  case .message:
    if let thread = entity.thread {
      return "/thread/\(thread)?message=\(entity.id)"
    }
    return "/c/\(entity.channel ?? "general")?message=\(entity.id)"
  case .task, .proposal, .thread:
    return "/\(entity.kind.rawValue)/\(entity.id)"
  }
}

nonisolated(unsafe) private let entityPath = #//(task|proposal|thread)/([0-9A-HJKMNP-TV-Z]{26})/#
nonisolated(unsafe) private let cronPath = #//crons\?cron=([0-9A-HJKMNP-TV-Z]{26})/#
nonisolated(unsafe) private let threadMessagePath = #//thread/([0-9A-HJKMNP-TV-Z]{26})\?message=([0-9A-HJKMNP-TV-Z]{26})/#
nonisolated(unsafe) private let channelMessagePath = #//c/([a-z0-9-]+(?:/[a-z0-9-]+)?)\?message=([0-9A-HJKMNP-TV-Z]{26})/#

/// The entity a link to the board's own view points at, or nil for any other link.
public func entityOfHref(_ href: String?) -> EntityLink? {
  guard let href else {
    return nil
  }
  if let cron = href.wholeMatch(of: cronPath) {
    return EntityLink(kind: .cron, id: String(cron.1))
  }
  if let message = href.wholeMatch(of: threadMessagePath) {
    // The channel goes unused while there is a thread; the link opens the thread.
    return EntityLink(kind: .message, id: String(message.2), channel: "", thread: String(message.1))
  }
  if let message = href.wholeMatch(of: channelMessagePath) {
    return EntityLink(kind: .message, id: String(message.2), channel: String(message.1))
  }
  guard let match = href.wholeMatch(of: entityPath),
    let kind = EntityKind(rawValue: String(match.1))
  else {
    return nil
  }
  return EntityLink(kind: kind, id: String(match.2))
}

/// A path through a task conversation's worktree on any runner, `<data>/worktrees/<agent>/.tasks/
/// <task id>/<path>`, read from `worktrees/` on, so no runner has to say where its data lives.
nonisolated(unsafe) private let taskWorktree = #/(?:^|/)worktrees/[^/]+/\.tasks/([0-9A-HJKMNP-TV-Z]{26})(?:/(.*))?\z/#
nonisolated(unsafe) private let scheme = #/(?i)[a-z][a-z0-9+.\-]*:/#
/// A line cited after a path, as both CLIs write one: `report.md:67`, or with its column.
nonisolated(unsafe) private let lineSuffix = #/:([0-9]+)(?::[0-9]+)?\z/#
/// A line cited the way GitHub links one: `#L67`, or a range from it.
nonisolated(unsafe) private let lineFragment = #/#L([0-9]+)/#
/// A relative path citing a line, `report.md:67`, which a URL parser takes for a scheme.
nonisolated(unsafe) private let citedRelative = #/[^/?#:]*\.[^/?#:]*:[0-9]+(?::[0-9]+)?(?:[?#].*)?/#

/// Whether an address is a relative file with a cited line rather than a URL with a scheme.
public func isCitedPath(_ href: String) -> Bool {
  href.wholeMatch(of: citedRelative) != nil
}

/// A path with the line a citation names after it split off.
public func citedLine(_ path: String) -> (path: String, line: Int?) {
  guard let match = path.firstMatch(of: lineSuffix), let line = Int(match.1), line > 0 else {
    return (path, nil)
  }
  return (String(path[..<match.range.lowerBound]), line)
}

/// A path's segments with `.` and `..` resolved, or nil when `..` climbs out of the root.
public func normalizePath(_ path: String) -> String? {
  var segments: [Substring] = []
  for segment in path.split(separator: "/", omittingEmptySubsequences: false) {
    if segment.isEmpty || segment == "." {
      continue
    }
    if segment == ".." {
      if segments.popLast() == nil {
        return nil
      }
      continue
    }
    segments.append(segment)
  }
  return segments.joined(separator: "/")
}

/// The address with its percent escapes decoded, as `decodeURIComponent` decodes it, or as it is
/// when they don't decode.
private func decoded(_ href: String) -> String {
  href.removingPercentEncoding ?? href
}

/// Where a link goes, when it isn't an address the browser opens, which is nil. A path through a
/// task's worktree is that task's file, and a relative one in a file is the file beside it in the
/// same source; any other path names a place the board can't open. `image:<id>` is an image a
/// citizen uploaded. An address with a scheme, `//`, or only a fragment is the browser's.
public func linkTarget(_ href: String?, base: FileBase? = nil) -> LinkTarget? {
  // The URL filter turns an unsafe address, such as a script's, into an empty one.
  guard let href, !href.isEmpty else {
    return .local
  }
  if let upload = uploadedImageId(href) {
    return .upload(upload)
  }
  if href.hasPrefix("#") || href.hasPrefix("//")
    || (href.prefixMatch(of: scheme) != nil && !isCitedPath(href))
  {
    return nil
  }
  let unqueried = href.firstIndex { $0 == "?" || $0 == "#" }.map { String(href[..<$0]) } ?? href
  let cited = citedLine(decoded(unqueried))
  let path = cited.path
  let fragment = href.firstMatch(of: lineFragment).flatMap { Int($0.1) }
  let line = cited.line ?? fragment.flatMap { $0 > 0 ? $0 : nil }
  if let worktree = path.firstMatch(of: taskWorktree) {
    guard let inside = normalizePath(worktree.2.map(String.init) ?? "") else {
      return .local
    }
    return .file(source: .task(String(worktree.1)), path: inside, line: line)
  }
  if let base, !path.hasPrefix("/") {
    guard let inside = normalizePath("\(base.dir)/\(path)") else {
      return .local
    }
    return .file(source: base.source, path: inside, line: line)
  }
  return .local
}

/// The schemes an address may keep: the rest, such as a script's, are dropped.
nonisolated(unsafe) private let safeScheme = #/(?i)(?:https?|ircs?|mailto|xmpp)/#

/// The address a message's link or image keeps, as the web's markdown filter keeps it: a relative
/// address, one with a safe scheme, a relative file citing a line (`report.md:67`), or an uploaded
/// image's `image:<id>`; any other is dropped, as empty.
public func keptHref(_ href: String) -> String {
  if isCitedPath(href) || uploadedImageId(href) != nil {
    return href
  }
  guard let colon = href.firstIndex(of: ":") else {
    return href
  }
  for mark in ["?", "#", "/"] as [Character] {
    if let found = href.firstIndex(of: mark), colon > found {
      return href
    }
  }
  return href[..<colon].wholeMatch(of: safeScheme) == nil ? "" : href
}
