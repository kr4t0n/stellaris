// Ids in text read as what they name, a port of `withTitles`, `splitEntities`, `unknownIds`, and
// the messages of `entityIndex` in the web's `apps/web/src/lib/entities.ts`: a message's markdown
// reads them as links named by their titles, and a place that can't hold a link, as the line a post
// raises in the sky, as the titles alone. Both run the case table in `apps/ios/fixtures/cases`.

import Foundation

/// The 26 characters a ULID is written in, Crockford's base 32.
private func isULIDUnit(_ unit: UInt16) -> Bool {
  switch unit {
  case 0x30...0x39: true  // 0-9
  case 0x41...0x48, 0x4A, 0x4B, 0x4D, 0x4E, 0x50...0x54, 0x56...0x5A: true  // A-Z less I, L, O, U
  default: false
  }
}

/// JavaScript's `\w` without the `u` flag: ASCII letters, digits, and the underscore.
private func isWordUnit(_ unit: UInt16) -> Bool {
  switch unit {
  case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x5F: true
  default: false
  }
}

private let slash: UInt16 = 0x2F
private let period: UInt16 = 0x2E
private let hyphen: UInt16 = 0x2D

/// Where each ULID standing alone starts, as the web's `ULID` pattern finds them: not inside a word,
/// a path such as a task's branch, or a file name. A period after one ends a sentence unless a word
/// goes on, as in `<id>.md`.
private func idStarts(in units: [UInt16]) -> [Int] {
  var starts: [Int] = []
  var index = 0
  while index + 26 <= units.count {
    let before = index > 0 ? units[index - 1] : nil
    let run = units[index..<index + 26].allSatisfy(isULIDUnit)
    let alone = before.map { !isWordUnit($0) && $0 != slash && $0 != period && $0 != hyphen } ?? true
    let end = index + 26
    let after = end < units.count ? units[end] : nil
    let afterAfter = end + 1 < units.count ? units[end + 1] : nil
    let ends =
      after.map { unit in
        !isWordUnit(unit) && unit != slash && unit != hyphen
          && !(unit == period && afterAfter.map(isWordUnit) == true)
      } ?? true
    if run && alone && ends {
      starts.append(index)
      index = end
    } else {
      index += 1
    }
  }
  return starts
}

/// What an id in the board's text names, and the words shown in its place. A message's says where
/// it sits, its thread or else its channel, which its link opens.
public struct EntityTitle: Sendable, Hashable {
  public let kind: EntityKind
  public let title: String
  public let channel: String?
  public let thread: String?

  public init(kind: EntityKind, title: String, channel: String? = nil, thread: String? = nil) {
    self.kind = kind
    self.title = title
    self.channel = channel
    self.thread = thread
  }
}

/// The messages `refs` name, as the web's `entityIndex` names them: "eng-1's post in #general", or
/// in a thread by its title from `threadTitles`, "your" for the user's own, with `name` for how an
/// author's name reads.
public func messageTitles(
  _ refs: [MessageRef], threadTitles: [String: String], name: (String) -> String
) -> [String: EntityTitle] {
  var index: [String: EntityTitle] = [:]
  for ref in refs {
    let place =
      ref.thread.map { threadTitles[$0] ?? "a thread in #\(ref.channel)" } ?? "#\(ref.channel)"
    let author = name(ref.author)
    let whose = author == "you" ? "your" : "\(author)'s"
    index[ref.id] = EntityTitle(
      kind: .message, title: "\(whose) post in \(place)", channel: ref.channel, thread: ref.thread)
  }
  return index
}

/// JavaScript's `\s`: the white space a web pattern skips.
func isJavaScriptWhiteSpace(_ scalar: Unicode.Scalar) -> Bool {
  switch scalar.value {
  case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
    0xFEFF:
    true
  default:
    false
  }
}

private func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
  scalar.isASCII && isWordUnit(UInt16(scalar.value))
}

/// `text` without the words agents write right before a message's id, "message" or "post" and
/// whose it is, which its title already says, as the web's `MESSAGE_WORD` finds them:
/// `(?:\b(?:my|your|our|their|his|her|its|[\w-]+['’]s)\s+)?\b(?:message|post)\s+$`, without
/// regard to case.
public func withoutMessageWord(_ text: String) -> String {
  let scalars = Array(text.unicodeScalars)
  func string(_ end: Int) -> String {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: scalars[..<end])
    return String(view)
  }
  func lowered(_ from: Int, _ to: Int) -> String {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: scalars[from..<to])
    return String(view).lowercased()
  }
  var end = scalars.count
  while end > 0, isJavaScriptWhiteSpace(scalars[end - 1]) {
    end -= 1
  }
  var word = end
  while word > 0, isWordScalar(scalars[word - 1]) {
    word -= 1
  }
  guard end < scalars.count, ["message", "post"].contains(lowered(word, end)) else {
    return text
  }
  // Whose post it is, when white space and a word come right before.
  var gap = word
  while gap > 0, isJavaScriptWhiteSpace(scalars[gap - 1]) {
    gap -= 1
  }
  guard gap < word, gap > 0 else {
    return string(word)
  }
  var pronoun = gap
  while pronoun > 0, isWordScalar(scalars[pronoun - 1]) {
    pronoun -= 1
  }
  let pronouns = ["my", "your", "our", "their", "his", "her", "its"]
  if pronoun < gap, pronouns.contains(lowered(pronoun, gap)) {
    return string(pronoun)
  }
  // A name and `'s` or `’s`: the earliest place a word boundary starts its run of word characters
  // and hyphens.
  guard gap >= 3, lowered(gap - 1, gap) == "s", ["'", "’"].contains(scalars[gap - 2]) else {
    return string(word)
  }
  let quote = gap - 2
  var run = quote
  while run > 0, isWordScalar(scalars[run - 1]) || scalars[run - 1] == "-" {
    run -= 1
  }
  for start in run..<quote {
    let before = start > 0 && isWordScalar(scalars[start - 1])
    if before != isWordScalar(scalars[start]) {
      return string(start)
    }
  }
  return string(word)
}

/// A piece of text cut at the ids an index knows: text as written, or an id the index knows.
public enum EntityPiece: Sendable, Hashable {
  case text(String)
  case entity(id: String, EntityTitle)
}

/// `text` cut at each id `index` knows, standing alone as the web's `splitEntities` finds one. A
/// title written right after its id, quoted or after a colon, as agents and the board often write
/// it, is dropped, since the id now reads as the title, and so are "message" or "post", and whose,
/// right before a message's id. An empty piece of text is left out.
public func splitEntities(_ text: String, index: [String: EntityTitle]) -> [EntityPiece] {
  guard !index.isEmpty else {
    return text.isEmpty ? [] : [.text(text)]
  }
  let units = Array(text.utf16)
  func slice(_ from: Int, _ to: Int) -> String {
    String(decoding: units[from..<to], as: UTF16.self)
  }
  var pieces: [EntityPiece] = []
  var last = 0
  for start in idStarts(in: units) {
    let id = slice(start, start + 26)
    guard let entity = index[id], start >= last else {
      continue
    }
    let before = slice(last, start)
    let kept = entity.kind == .message ? withoutMessageWord(before) : before
    if !kept.isEmpty {
      pieces.append(.text(kept))
    }
    pieces.append(.entity(id: id, entity))
    last = start + 26
    let echo = [" \"\(entity.title)\"", ": \(entity.title)"].first { each in
      let echoed = Array(each.utf16)
      return units.count - last >= echoed.count
        && Array(units[last..<last + echoed.count]) == echoed
    }
    last += echo.map { $0.utf16.count } ?? 0
  }
  if last < units.count {
    pieces.append(.text(slice(last, units.count)))
  }
  return pieces
}

/// The ids in `text` that `index` doesn't know, each once, in the order they come, which may name
/// messages; an uploaded image's, written `image:<id>`, never does.
public func unknownIds(_ text: String, index: [String: EntityTitle]) -> [String] {
  let units = Array(text.utf16)
  let scheme = Array("image:".utf16)
  var found: [String] = []
  var seen = Set<String>()
  for start in idStarts(in: units) {
    if start >= scheme.count, Array(units[start - scheme.count..<start]) == scheme {
      continue
    }
    let id = String(decoding: units[start..<start + 26], as: UTF16.self)
    if index[id] == nil, seen.insert(id).inserted {
      found.append(id)
    }
  }
  return found
}

/// `text` with each id `index` knows read as its title, as `splitEntities` cuts it.
public func withTitles(_ text: String, index: [String: EntityTitle]) -> String {
  splitEntities(text, index: index).map { piece in
    switch piece {
    case .text(let text): text
    case .entity(_, let entity): entity.title
    }
  }.joined()
}

/// `text` with each task's id `titles` knows read as its title.
public func withTitles(_ text: String, titles: [String: String]) -> String {
  withTitles(text, index: titles.mapValues { EntityTitle(kind: .task, title: $0) })
}
