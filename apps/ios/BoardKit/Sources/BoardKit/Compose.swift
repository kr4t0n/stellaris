// The mention being typed in a draft, a port of `mentionAt` and `completeMention` in the web's
// `apps/web/src/board/compose.ts`, and the place an image holds in it while it uploads, a port of
// `uploadingImage`, `uploadPlaceholder`, `insertAt`, and `settleUpload` there, and of
// `imageDescription` in `packages/shared/src/images.ts`. Both run the case tables
// `apps/ios/fixtures/cases/compose.json` and `uploads.json`. Positions count UTF-16 code units, as
// the web's string indices do.

/// The `@name` being typed where the caret is: where its `@` is and what is typed of the name.
public struct MentionFragment: Sendable, Hashable, Decodable {
  public let start: Int
  public let prefix: String

  public init(start: Int, prefix: String) {
    self.start = start
    self.prefix = prefix
  }
}

/// A draft with the mention being typed completed to a name, and where the caret goes next.
public struct CompletedMention: Sendable, Hashable, Decodable {
  public let text: String
  public let caret: Int

  public init(text: String, caret: Int) {
    self.text = text
    self.caret = caret
  }
}

/// The `@name` being typed before `caret`, as the web's `/(^|[^\w@])@([a-z0-9-]*)$/` finds it in
/// the text before the caret: an `@` at the start or after anything but a word character or another
/// `@`, then the name's letters, digits, and hyphens up to the caret. A word character is ASCII's,
/// as JavaScript's `\w` is without the `u` flag.
public func mentionAt(_ text: String, caret: Int) -> MentionFragment? {
  let units = Array(text.utf16)
  guard caret >= 0, caret <= units.count else {
    return nil
  }
  var start = caret
  while start > 0, isNameUnit(units[start - 1]) {
    start -= 1
  }
  guard start > 0, units[start - 1] == at else {
    return nil
  }
  let sign = start - 1
  if sign > 0, isWordUnit(units[sign - 1]) || units[sign - 1] == at {
    return nil
  }
  return MentionFragment(
    start: sign, prefix: String(decoding: units[start..<caret], as: UTF16.self))
}

/// `text` with the mention typed from `start` to `caret` completed to `@name` and a space, and the
/// caret after them.
public func completeMention(_ text: String, caret: Int, start: Int, name: String)
  -> CompletedMention
{
  let units = Array(text.utf16)
  let from = min(max(start, 0), units.count)
  let to = min(max(caret, from), units.count)
  let inserted = "@\(name) "
  let completed =
    String(decoding: units[..<from], as: UTF16.self) + inserted
    + String(decoding: units[to...], as: UTF16.self)
  return CompletedMention(text: completed, caret: from + inserted.utf16.count)
}

/// A draft after an edit, and where its caret goes.
public struct DraftEdit: Sendable, Hashable, Decodable {
  public let text: String
  public let caret: Int

  public init(text: String, caret: Int) {
    self.text = text
    self.caret = caret
  }
}

/// A file's name as an image's description in markdown, as the board writes one: no brackets,
/// backslashes, or line breaks, which would end the description, and no backticks, which would open
/// a code span that a later one in the post closes.
public func imageDescription(_ name: String) -> String {
  String(
    name.unicodeScalars.filter { !"[]\\\r\n`".unicodeScalars.contains($0) }.map(Character.init))
}

/// What holds an image's place in a draft while it uploads, in the words that say so, numbered
/// from the second line of one name on.
public func uploadingImage(_ name: String, number: Int = 1) -> String {
  number == 1
    ? "![Uploading \(imageDescription(name))…]()"
    : "![Uploading \(imageDescription(name)) (\(number))…]()"
}

/// A line of its own for an upload of an image named `name`: the first numbering found neither in
/// `text` nor among `held`, the lines of uploads still on their way, so each upload fills its own
/// line even when every image has the same name, as every image the app posts does.
public func uploadPlaceholder(for name: String, in text: String, held: [String]) -> String {
  var number = 1
  while true {
    let line = uploadingImage(name, number: number)
    if firstUnit(of: Array(line.utf16), in: Array(text.utf16)) == nil, !held.contains(line) {
      return line
    }
    number += 1
  }
}

/// `text` with `inserted` in place of what is selected from `start` to `end`, and the caret after
/// it.
public func insertAt(_ text: String, start: Int, end: Int, inserted: String) -> DraftEdit {
  let units = Array(text.utf16)
  let from = min(max(start, 0), units.count)
  let to = min(max(end, from), units.count)
  return DraftEdit(
    text: String(decoding: units[..<from], as: UTF16.self) + inserted
      + String(decoding: units[to...], as: UTF16.self),
    caret: from + inserted.utf16.count)
}

/// `text` with the first `placeholder` in it replaced by `markdown`, the image's once it is kept or
/// nothing when it was not, and the caret where it was among the text around it, or after the
/// markdown when it was inside the placeholder; nil when the placeholder is gone, as when the user
/// deleted it, which leaves the upload out of the post.
public func settleUpload(_ text: String, caret: Int, placeholder: String, markdown: String)
  -> DraftEdit?
{
  let units = Array(text.utf16)
  let held = Array(placeholder.utf16)
  guard let start = firstUnit(of: held, in: units) else {
    return nil
  }
  let end = start + held.count
  let length = markdown.utf16.count
  return DraftEdit(
    text: String(decoding: units[..<start], as: UTF16.self) + markdown
      + String(decoding: units[end...], as: UTF16.self),
    caret: caret <= start ? caret : caret >= end ? caret - held.count + length : start + length)
}

/// An image a draft holds, where it stands: one the board kept, by its id and description, or one
/// still uploading, by the line an upload holds, described by what that line names, such as
/// `image (2)`, which tells two uploads of one name apart. `start` and `text` place it in the
/// draft, `start` in UTF-16 code units, as the web counts them.
public struct DraftImage: Sendable, Hashable, Decodable {
  public enum Kind: String, Sendable, Hashable, Decodable {
    case kept, uploading
  }

  public let kind: Kind
  public let start: Int
  public let text: String
  public let id: String?
  public let alt: String

  public init(kind: Kind, start: Int, text: String, id: String?, alt: String) {
    self.kind = kind
    self.start = start
    self.text = text
    self.id = id
    self.alt = alt
  }
}

/// The images a draft holds, in the order they stand in it: each uploaded image's markdown,
/// `![alt](image:<ULID>)` with no `]` or line break in its description, and each line in `held` an
/// upload on its way still holds. A web image's markdown is none of them.
public func draftImages(_ text: String, held: [String]) -> [DraftImage] {
  let units = Array(text.utf16)
  var found: [DraftImage] = []
  var from = 0
  let opening = Array("![".utf16)
  let middle = Array("](image:".utf16)
  while let start = firstUnit(of: opening, in: Array(units[from...])).map({ $0 + from }) {
    from = start + 1
    var close = start + opening.count
    while close < units.count, units[close] != bracket, units[close] != newline {
      close += 1
    }
    let idStart = close + middle.count
    guard close + middle.count + 27 <= units.count,
      units[close..<idStart].elementsEqual(middle),
      units[idStart + 26] == parenthesis,
      units[idStart..<idStart + 26].allSatisfy(isUlidUnit)
    else {
      continue
    }
    let end = idStart + 27
    found.append(
      DraftImage(
        kind: .kept, start: start,
        text: String(decoding: units[start..<end], as: UTF16.self),
        id: String(decoding: units[idStart..<idStart + 26], as: UTF16.self),
        alt: String(decoding: units[(start + opening.count)..<close], as: UTF16.self)))
    from = end
  }
  for line in held {
    if let start = firstUnit(of: Array(line.utf16), in: units) {
      // The words between `![Uploading ` and `…]()`, as `uploadingImage` writes the line.
      let alt = String(line.dropFirst("![Uploading ".count).dropLast("…]()".count))
      found.append(DraftImage(kind: .uploading, start: start, text: line, id: nil, alt: alt))
    }
  }
  return found.enumerated().sorted { ($0.element.start, $0.offset) < ($1.element.start, $1.offset) }
    .map(\.element)
}

/// The draft without `image`, and the caret where it was among the text around it, or where the
/// image stood when it was inside it; the draft as it is when the image no longer stands there.
public func removeDraftImage(_ text: String, caret: Int, image: DraftImage) -> DraftEdit {
  let units = Array(text.utf16)
  let removed = Array(image.text.utf16)
  let end = image.start + removed.count
  guard image.start >= 0, end <= units.count, units[image.start..<end].elementsEqual(removed) else {
    return DraftEdit(text: text, caret: caret)
  }
  return DraftEdit(
    text: String(decoding: units[..<image.start], as: UTF16.self)
      + String(decoding: units[end...], as: UTF16.self),
    caret: caret <= image.start
      ? caret : caret >= end ? caret - removed.count : image.start)
}

/// `text` without any line holding an image's place while it uploads, as a draft saved before the
/// app ended holds one with no upload left to fill it.
public func droppingUploadLines(_ text: String) -> String {
  text.replacing(/!\[Uploading [^\]\n]*…\]\(\)/, with: "")
}

private let bracket = UInt16(UInt8(ascii: "]"))
private let newline = UInt16(UInt8(ascii: "\n"))
private let parenthesis = UInt16(UInt8(ascii: ")"))

/// A character of a ULID: a digit or a capital in Crockford's base 32, without I, L, O, or U.
private func isUlidUnit(_ unit: UInt16) -> Bool {
  switch unit {
  case 0x30...0x39: true
  case 0x41...0x5A: ![0x49, 0x4C, 0x4F, 0x55].contains(unit)
  default: false
  }
}

/// Where `needle` first starts in `units`, in UTF-16 code units, as a JavaScript string's `indexOf`
/// finds it; nil for an empty needle or none.
private func firstUnit(of needle: [UInt16], in units: [UInt16]) -> Int? {
  guard !needle.isEmpty, units.count >= needle.count else {
    return nil
  }
  return (0...(units.count - needle.count)).first {
    units[$0..<$0 + needle.count].elementsEqual(needle)
  }
}

private let at = UInt16(UInt8(ascii: "@"))

/// A name's letters, digits, and hyphens.
private func isNameUnit(_ unit: UInt16) -> Bool {
  switch unit {
  case 0x61...0x7A, 0x30...0x39, 0x2D: true
  default: false
  }
}

/// A word character as JavaScript's `\w` reads one: an ASCII letter, a digit, or an underscore.
private func isWordUnit(_ unit: UInt16) -> Bool {
  switch unit {
  case 0x61...0x7A, 0x41...0x5A, 0x30...0x39, 0x5F: true
  default: false
  }
}
