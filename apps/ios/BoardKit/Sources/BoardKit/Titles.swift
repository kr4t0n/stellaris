// Ids in text read as what they name, a port of `withTitles` and `splitEntities` in the web's
// `apps/web/src/lib/entities.ts`: a message's markdown reads them as links named by their titles,
// and a place that can't hold a link, as the line a post raises in the sky, as the titles alone.
// Both run the case table in `apps/ios/fixtures/cases`. The web's rule for a message's id, which
// drops "post" and whose before it, has no port: the app names no messages yet.

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

/// What an id in the board's text names, and the words shown in its place.
public struct EntityTitle: Sendable, Hashable {
  public let kind: EntityKind
  public let title: String

  public init(kind: EntityKind, title: String) {
    self.kind = kind
    self.title = title
  }
}

/// A piece of text cut at the ids an index knows: text as written, or an id the index knows.
public enum EntityPiece: Sendable, Hashable {
  case text(String)
  case entity(id: String, EntityTitle)
}

/// `text` cut at each id `index` knows, standing alone as the web's `splitEntities` finds one. A
/// title written right after its id, quoted or after a colon, as agents and the board often write
/// it, is dropped, since the id now reads as the title. An empty piece of text is left out.
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
    if start > last {
      pieces.append(.text(slice(last, start)))
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

/// `text` with each id `titles` knows read as its title, as `splitEntities` cuts it.
public func withTitles(_ text: String, titles: [String: String]) -> String {
  let index = titles.mapValues { EntityTitle(kind: .task, title: $0) }
  return splitEntities(text, index: index).map { piece in
    switch piece {
    case .text(let text): text
    case .entity(_, let entity): entity.title
    }
  }.joined()
}
