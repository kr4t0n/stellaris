// Ids in a line read as what they name, a port of `withTitles` and `splitEntities` in the web's
// `apps/web/src/lib/entities.ts`, for places that can't hold a link, as the line a post raises in
// the sky. Both run the case table in `apps/ios/fixtures/cases`. The web's rule for a message's id,
// which drops "post" and whose before it, has no port: the app names no messages yet.

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

/// `text` with each id `titles` knows read as its title. A title written right after its id,
/// quoted or after a colon, as agents and the board often write it, is dropped, since the id now
/// reads as the title.
public func withTitles(_ text: String, titles: [String: String]) -> String {
  guard !titles.isEmpty else {
    return text
  }
  let units = Array(text.utf16)
  func slice(_ from: Int, _ to: Int) -> String {
    String(decoding: units[from..<to], as: UTF16.self)
  }
  var pieces: [String] = []
  var last = 0
  for start in idStarts(in: units) {
    let id = slice(start, start + 26)
    guard let title = titles[id], start >= last else {
      continue
    }
    pieces.append(slice(last, start))
    pieces.append(title)
    last = start + 26
    let echo = [" \"\(title)\"", ": \(title)"].first { each in
      let echoed = Array(each.utf16)
      return units.count - last >= echoed.count
        && Array(units[last..<last + echoed.count]) == echoed
    }
    last += echo.map { $0.utf16.count } ?? 0
  }
  pieces.append(slice(last, units.count))
  return pieces.joined()
}
