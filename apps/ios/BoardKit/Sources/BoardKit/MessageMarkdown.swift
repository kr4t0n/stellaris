// A message's markdown as the app draws it, read as the web's `Markdown` component reads it
// (`apps/web/src/components/Markdown.tsx`): GitHub's flavour, with tables, strikethrough, task
// lists and literal autolinks; raw HTML shown as written; unsafe addresses dropped; ids of what the
// board knows read as links named by their titles; and `@name` marked outside code and links.
// swift-markdown parses it; the app draws the blocks this gives.

import Foundation
import Markdown

/// How a run of a message's text is set.
public struct MessageStyle: OptionSet, Sendable, Hashable {
  public let rawValue: Int

  public init(rawValue: Int) {
    self.rawValue = rawValue
  }

  public static let emphasis = MessageStyle(rawValue: 1 << 0)
  public static let strong = MessageStyle(rawValue: 1 << 1)
  public static let strikethrough = MessageStyle(rawValue: 1 << 2)
}

/// Where a link in a message goes.
public enum MessageLink: Sendable, Hashable {
  /// A task's, a proposal's, or a thread's view, a cron, or a message in its thread or channel.
  case entity(EntityLink)
  /// A file on a task's branch or a project's default branch.
  case file(source: FileSource, path: String, line: Int?)
  /// An address the browser opens, as the message wrote it.
  case web(String)

  /// What a link to `href` does, once the filter has kept it; nil where it goes nowhere, as for a
  /// path on a machine or an uploaded image, which read as text.
  public init?(href: String) {
    if let entity = entityOfHref(href) {
      self = .entity(entity)
      return
    }
    switch linkTarget(href) {
    case .file(let source, let path, let line):
      self = .file(source: source, path: path, line: line)
    case .upload, .local:
      return nil
    case nil:
      self = .web(href)
    }
  }
}

/// A run of a message's text: written text, code, or a mention.
public struct MessageRun: Sendable, Hashable {
  public enum Kind: Sendable, Hashable {
    case text, code, mention
  }

  public let text: String
  public let kind: Kind
  public let style: MessageStyle
  public let link: MessageLink?

  public init(
    _ text: String, kind: Kind = .text, style: MessageStyle = [], link: MessageLink? = nil
  ) {
    self.text = text
    self.kind = kind
    self.style = style
    self.link = link
  }
}

/// Where an image in a message loads from.
public enum MessageImageSource: Sendable, Hashable {
  /// An image a citizen uploaded, by its id.
  case upload(String)
  /// An image on a task's branch or a project's default branch.
  case file(source: FileSource, path: String)
  /// An address the browser loads.
  case web(String)
}

public struct MessageImage: Sendable, Hashable {
  /// Where it loads from; nil for a path on a machine, which reads as `text`.
  public let source: MessageImageSource?
  /// Its description, which VoiceOver reads and a failure shows.
  public let alt: String
  /// What reads in its place when nothing loads it: its description, or else its path on a
  /// machine, or "an image".
  public let text: String
  /// Where a tap goes, for an image inside a link.
  public let link: MessageLink?
}

public enum MessageInline: Sendable, Hashable {
  case run(MessageRun)
  case image(MessageImage)
  /// A hard line break.
  case lineBreak
}

public struct MessageListItem: Sendable, Hashable {
  /// A task list's box, ticked or not; nil for an ordinary item.
  public let checked: Bool?
  public let blocks: [MessageBlock]
}

public enum MessageAlignment: Sendable, Hashable {
  case leading, center, trailing
}

public struct MessageTable: Sendable, Hashable {
  /// Each column's alignment, nil where the table sets none.
  public let alignments: [MessageAlignment?]
  public let head: [[MessageInline]]
  public let rows: [[[MessageInline]]]
}

public indirect enum MessageBlock: Sendable, Hashable {
  case paragraph([MessageInline])
  case heading(level: Int, [MessageInline])
  /// `start` is an ordered list's first number; nil for a bulleted list.
  case list(start: Int?, items: [MessageListItem])
  case quote([MessageBlock])
  case code(language: String?, text: String)
  case table(MessageTable)
  case rule
}

/// A message's markdown as blocks to draw.
public struct MessageDocument: Sendable, Hashable {
  public let blocks: [MessageBlock]

  /// Reads `markdown`, with each id `entities` knows read as a link named by its title.
  public init(markdown: String, entities: [String: EntityTitle] = [:]) {
    // Quotes and dashes stay as written, as the web shows them.
    let document = Document(parsing: markdown, options: [.disableSmartOpts])
    blocks = MarkdownReader(entities: entities).blocks(document.children)
  }

  public init(blocks: [MessageBlock]) {
    self.blocks = blocks
  }
}

/// A piece of inline content before its text is read for autolinks, ids, and mentions. Text in a
/// link, even one that goes nowhere, and raw HTML are written as they are, never read.
private enum Pending {
  case text(String, MessageStyle)
  case written(String, MessageStyle, MessageLink?)
  case code(String, MessageStyle, MessageLink?)
  case image(MessageImage)
  case lineBreak
}

private struct MarkdownReader {
  let entities: [String: EntityTitle]

  func blocks(_ children: MarkupChildren) -> [MessageBlock] {
    children.compactMap(block)
  }

  func block(_ markup: any Markup) -> MessageBlock? {
    switch markup {
    case let paragraph as Paragraph:
      return .paragraph(inlines(paragraph.children))
    case let heading as Heading:
      return .heading(level: heading.level, inlines(heading.children))
    case let list as UnorderedList:
      return .list(start: nil, items: list.listItems.map(item))
    case let list as OrderedList:
      return .list(start: Int(list.startIndex), items: list.listItems.map(item))
    case let quote as BlockQuote:
      return .quote(blocks(quote.children))
    case let code as CodeBlock:
      let language = code.language.flatMap { $0.isEmpty ? nil : $0 }
      return .code(language: language, text: withoutFinalNewline(code.code))
    case let table as Table:
      return .table(
        MessageTable(
          alignments: table.columnAlignments.map { alignment in
            switch alignment {
            case .left: .leading
            case .center: .center
            case .right: .trailing
            case nil: nil
            }
          },
          head: table.head.cells.map { inlines($0.children) },
          rows: table.body.rows.map { row in row.cells.map { inlines($0.children) } }))
    case is ThematicBreak:
      return .rule
    case let html as HTMLBlock:
      // Raw HTML shows as written, never as markup.
      return .paragraph([.run(MessageRun(withoutFinalNewline(html.rawHTML)))])
    default:
      let text = withoutFinalNewline(markup.format())
      return text.isEmpty ? nil : .paragraph([.run(MessageRun(text))])
    }
  }

  func item(_ item: ListItem) -> MessageListItem {
    let checked: Bool? =
      switch item.checkbox {
      case .checked: true
      case .unchecked: false
      case nil: nil
      }
    return MessageListItem(checked: checked, blocks: blocks(item.children))
  }

  /// The inline content of a block, its text read for autolinks, then ids, then mentions, as the
  /// web's plugins read it, outside code and links.
  func inlines(_ children: MarkupChildren) -> [MessageInline] {
    var pending: [Pending] = []
    collect(children, style: [], link: nil, inLink: false, into: &pending)
    var merged: [Pending] = []
    for piece in pending {
      switch (piece, merged.last) {
      case (.text(let text, let style), .text(let before, let earlier)?) where earlier == style:
        merged[merged.count - 1] = .text(before + text, style)
      case (.written(let text, let style, let link), .written(let before, let earlier, let went)?)
      where earlier == style && went == link:
        merged[merged.count - 1] = .written(before + text, style, link)
      default:
        merged.append(piece)
      }
    }
    let read = merged.flatMap { piece -> [MessageInline] in
      switch piece {
      case .text(let text, let style):
        return read(text, style: style)
      case .written(let text, let style, let link):
        return [.run(MessageRun(text, style: style, link: link))]
      case .code(let text, let style, let link):
        return [.run(MessageRun(text, kind: .code, style: style, link: link))]
      case .image(let image):
        return [.image(image)]
      case .lineBreak:
        return [.lineBreak]
      }
    }
    // Runs set alike read as one, as the text around an autolink's trailing punctuation.
    var joined: [MessageInline] = []
    for inline in read {
      if case .run(let run) = inline, case .run(let before)? = joined.last,
        before.kind == .text, run.kind == .text, before.style == run.style, before.link == run.link
      {
        joined[joined.count - 1] = .run(
          MessageRun(before.text + run.text, style: run.style, link: run.link))
      } else {
        joined.append(inline)
      }
    }
    return joined
  }

  /// The pieces of `children`, set in `style`; `link` is where the link they sit in goes, and
  /// `inLink` says they sit in one, even one that goes nowhere.
  private func collect(
    _ children: MarkupChildren, style: MessageStyle, link: MessageLink?, inLink: Bool,
    into pending: inout [Pending]
  ) {
    func words(_ text: String) -> Pending {
      inLink ? .written(text, style, link) : .text(text, style)
    }
    for child in children {
      switch child {
      case let text as Markdown.Text:
        pending.append(words(text.string))
      case is SoftBreak:
        pending.append(words(" "))
      case is LineBreak:
        pending.append(.lineBreak)
      case let emphasis as Emphasis:
        collect(
          emphasis.children, style: style.union(.emphasis), link: link, inLink: inLink,
          into: &pending)
      case let strong as Strong:
        collect(
          strong.children, style: style.union(.strong), link: link, inLink: inLink, into: &pending)
      case let struck as Strikethrough:
        collect(
          struck.children, style: style.union(.strikethrough), link: link, inLink: inLink,
          into: &pending)
      case let code as InlineCode:
        // Agents often quote an id as code; a code span that is nothing but a known id names it,
        // and a message's drops the "post" and whose before it.
        let id = code.code.trimmingCharacters(in: .whitespaces)
        if !inLink, let entity = entities[id] {
          if entity.kind == .message, case .text(let before, let beforeStyle)? = pending.last {
            pending[pending.count - 1] = .text(withoutMessageWord(before), beforeStyle)
          }
          pending.append(.written(entity.title, style, .entity(entity.link(id))))
        } else {
          pending.append(.code(code.code, style, link))
        }
      case let anchor as Markdown.Link:
        let target = MessageLink(href: keptHref(anchor.destination ?? ""))
        collect(anchor.children, style: style, link: link ?? target, inLink: true, into: &pending)
      case let image as Markdown.Image:
        pending.append(.image(self.image(image, link: link)))
      case let html as InlineHTML:
        // Raw HTML is shown as written, apart from the text around it, as the web shows it.
        pending.append(.written(html.rawHTML, style, link))
      case let container as any InlineContainer:
        collect(container.children, style: style, link: link, inLink: inLink, into: &pending)
      default:
        let text = (child as? any PlainTextConvertibleMarkup)?.plainText ?? child.format()
        pending.append(words(text))
      }
    }
  }

  /// A markup's text with code as its words alone, as the web reads an image's description.
  private func plain(_ markup: any Markup) -> String {
    switch markup {
    case let text as Markdown.Text: text.string
    case let code as InlineCode: code.code
    case is SoftBreak: " "
    case is LineBreak: "\n"
    case let html as InlineHTML: html.rawHTML
    default: markup.children.map(plain).joined()
    }
  }

  private func image(_ image: Markdown.Image, link: MessageLink?) -> MessageImage {
    let source = keptHref(image.source ?? "")
    let alt = image.children.map(plain).joined()
    let loads: MessageImageSource?
    switch linkTarget(source) {
    case .file(let from, let path, _): loads = .file(source: from, path: path)
    case .upload(let id): loads = .upload(id)
    case .local: loads = nil
    case nil: loads = .web(source)
    }
    let text = !alt.isEmpty ? alt : loads == nil ? source : "an image"
    return MessageImage(source: loads, alt: alt, text: text, link: link)
  }

  /// Text outside code and links, read for literal autolinks, then for the ids `entities` knows,
  /// then for mentions.
  private func read(_ text: String, style: MessageStyle) -> [MessageInline] {
    var inlines: [MessageInline] = []
    for piece in autolinked(text) {
      guard case .plain(let plain) = piece else {
        if case .link(let shown, let href) = piece {
          inlines.append(.run(MessageRun(shown, style: style, link: MessageLink(href: href))))
        }
        continue
      }
      for part in splitEntities(plain, index: entities) {
        switch part {
        case .entity(let id, let entity):
          let link = MessageLink.entity(entity.link(id))
          inlines.append(.run(MessageRun(entity.title, style: style, link: link)))
        case .text(let words):
          for mention in mentioned(words) {
            switch mention {
            case .plain(let words):
              inlines.append(.run(MessageRun(words, style: style)))
            case .mention(let name):
              inlines.append(.run(MessageRun("@" + name, kind: .mention, style: style)))
            }
          }
        }
      }
    }
    return inlines
  }

  private func withoutFinalNewline(_ text: String) -> String {
    text.hasSuffix("\n") ? String(text.dropLast()) : text
  }
}

extension EntityTitle {
  /// Where a link to the entity with this title goes.
  fileprivate func link(_ id: String) -> EntityLink {
    EntityLink(kind: kind, id: id, channel: channel, thread: thread)
  }
}

// MARK: Literal autolinks

/// A piece of text read for literal autolinks: as written, or an address and the text it shows.
private enum Autolinked {
  case plain(String)
  case link(String, href: String)
}

/// The web's literal autolinks, as `mdast-util-gfm-autolink-literal` finds them in text outside
/// links: `http://`, `https://`, and `www.` addresses first, then mail addresses in what is left.
private func autolinked(_ text: String) -> [Autolinked] {
  var pieces: [Autolinked] = []
  for piece in found(in: text, by: urlLiteral, link: url) {
    if case .plain(let rest) = piece {
      pieces += found(in: rest, by: emailLiteral, link: email)
    } else {
      pieces.append(piece)
    }
  }
  return pieces
}

// JavaScript's `\w` is ASCII: letters, digits, and the underscore. A `Regex` isn't `Sendable`, but
// nothing changes one once it is made.
nonisolated(unsafe) private let urlLiteral =
  #/(?i)(https?:\/\/|www(?=\.))([\-.A-Za-z0-9_]+)([^ \t\r\n]*)/#.matchingSemantics(.unicodeScalar)
nonisolated(unsafe) private let emailLiteral =
  #/([\-.A-Za-z0-9_+]+)@([\-A-Za-z0-9_]+(?:\.[\-A-Za-z0-9_]+)+)/#.matchingSemantics(.unicodeScalar)

/// Each match `regex` finds in `text` that `link` takes, as a link, with the text around it; a
/// match it refuses is searched again from the next character, as the web's search goes on.
private func found<Output>(
  in text: String, by regex: Regex<Output>,
  link: (Regex<Output>.Match, String) -> [Autolinked]?
) -> [Autolinked] {
  var pieces: [Autolinked] = []
  let scalars = text.unicodeScalars
  var last = scalars.startIndex
  var from = scalars.startIndex
  while from < scalars.endIndex, let match = Substring(scalars[from...]).firstMatch(of: regex) {
    guard let linked = link(match, text) else {
      from = scalars.index(after: match.range.lowerBound)
      continue
    }
    if match.range.lowerBound > last {
      pieces.append(.plain(String(scalars[last..<match.range.lowerBound])))
    }
    pieces += linked
    last = match.range.upperBound
    from = match.range.upperBound
  }
  if last < scalars.endIndex {
    pieces.append(.plain(String(scalars[last...])))
  }
  return pieces
}

/// Whether a literal may start at `index`: at the start, or after white space or punctuation or a
/// symbol, as the web's `previous` reads the UTF-16 unit before it; a mail address never after `/`.
private func startsAfterBoundary(_ text: String, at index: String.Index, email: Bool) -> Bool {
  guard index > text.startIndex else {
    return true
  }
  let scalar = text.unicodeScalars[text.unicodeScalars.index(before: index)]
  // Past the basic plane, the unit before is half a surrogate pair, which is neither.
  guard scalar.value <= 0xFFFF else {
    return false
  }
  if email && scalar == "/" {
    return false
  }
  return isJavaScriptWhiteSpace(scalar) || isPunctuationOrSymbol(scalar)
}

private func isPunctuationOrSymbol(_ scalar: Unicode.Scalar) -> Bool {
  switch scalar.properties.generalCategory {
  case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation,
    .initialPunctuation, .finalPunctuation, .otherPunctuation, .mathSymbol, .currencySymbol,
    .modifierSymbol, .otherSymbol:
    true
  default:
    false
  }
}

private func url(
  _ match: Regex<(Substring, Substring, Substring, Substring)>.Match, _ text: String
) -> [Autolinked]? {
  guard startsAfterBoundary(text, at: match.range.lowerBound, email: false) else {
    return nil
  }
  var scheme = String(match.output.1)
  var domain = String(match.output.2)
  var prefix = ""
  // `www` is part of the domain.
  if scheme.lowercased().hasPrefix("w") {
    domain = scheme + domain
    scheme = ""
    prefix = "http://"
  }
  guard isCorrectDomain(domain) else {
    return nil
  }
  let (address, trail) = splitTrail(domain + String(match.output.3))
  guard !address.isEmpty else {
    return nil
  }
  let link = Autolinked.link(scheme + address, href: prefix + scheme + address)
  return trail.isEmpty ? [link] : [link, .plain(trail)]
}

private func email(
  _ match: Regex<(Substring, Substring, Substring)>.Match, _ text: String
) -> [Autolinked]? {
  let label = match.output.2
  guard startsAfterBoundary(text, at: match.range.lowerBound, email: true),
    let last = label.last, !(last == "-" || last == "_" || ("0"..."9").contains(last))
  else {
    return nil
  }
  let shown = "\(match.output.1)@\(label)"
  return [.link(shown, href: "mailto:" + shown)]
}

/// A domain of two parts or more, whose last two hold a letter or a digit and no underscore.
private func isCorrectDomain(_ domain: String) -> Bool {
  let parts = domain.split(separator: ".", omittingEmptySubsequences: false)
  guard parts.count >= 2 else {
    return false
  }
  for part in parts.suffix(2) where !part.isEmpty {
    if part.contains("_") || !part.contains(where: { $0.isASCII && ($0.isLetter || $0.isNumber) }) {
      return false
    }
  }
  return true
}

/// An address with the punctuation at its end split off, keeping the closing parentheses it opens.
private func splitTrail(_ address: String) -> (String, String) {
  let trailing: Set<Character> = [
    "!", "\"", "&", "'", ")", ",", ".", ":", ";", "<", ">", "?", "]", "}",
  ]
  var url = address
  var trail = ""
  while let last = url.last, trailing.contains(last) {
    trail.insert(last, at: trail.startIndex)
    url.removeLast()
  }
  guard !trail.isEmpty else {
    return (address, "")
  }
  let opening = url.filter { $0 == "(" }.count
  var closing = url.filter { $0 == ")" }.count
  while let paren = trail.firstIndex(of: ")"), opening > closing {
    url += trail[...paren]
    trail = String(trail[trail.index(after: paren)...])
    closing += 1
  }
  return (url, trail)
}

// MARK: Mentions

private enum Mentioned {
  case plain(String)
  case mention(String)
}

/// The board's mention pattern (`MENTION_PATTERN` in `@stellaris/shared/mentions`): `@name` after
/// the start or a character that is no word character and no `@`, and before none.
nonisolated(unsafe) private let mentionPattern =
  #/(^|[^A-Za-z0-9_@])@([a-z0-9][a-z0-9\-]{0,31})(?![A-Za-z0-9_\-])/#.matchingSemantics(
    .unicodeScalar)

private func mentioned(_ text: String) -> [Mentioned] {
  var pieces: [Mentioned] = []
  let scalars = text.unicodeScalars
  var last = scalars.startIndex
  for match in text.matches(of: mentionPattern) {
    let at = match.output.1.endIndex
    if at > last {
      pieces.append(.plain(String(scalars[last..<at])))
    }
    pieces.append(.mention(String(match.output.2)))
    last = match.range.upperBound
  }
  if last < scalars.endIndex {
    pieces.append(.plain(String(scalars[last...])))
  }
  return pieces
}
