// The mention being typed in a draft, a port of `mentionAt` and `completeMention` in the web's
// `apps/web/src/board/compose.ts`, and the place an image holds in it while it uploads, a port of
// `uploadingImage`, `insertAt`, and `settleUpload` there. Both run the case tables
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
/// backslashes, or line breaks.
public func imageDescription(_ name: String) -> String {
  String(name.unicodeScalars.filter { !"[]\\\r\n".unicodeScalars.contains($0) }.map(Character.init))
}

/// What holds an image's place in a draft while it uploads, in the words that say so.
public func uploadingImage(_ name: String) -> String {
  "![Uploading \(imageDescription(name))…]()"
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
  guard !held.isEmpty, units.count >= held.count,
    let start = (0...(units.count - held.count)).first(where: {
      units[$0..<$0 + held.count].elementsEqual(held)
    })
  else {
    return nil
  }
  let end = start + held.count
  let length = markdown.utf16.count
  return DraftEdit(
    text: String(decoding: units[..<start], as: UTF16.self) + markdown
      + String(decoding: units[end...], as: UTF16.self),
    caret: caret <= start ? caret : caret >= end ? caret - held.count + length : start + length)
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
