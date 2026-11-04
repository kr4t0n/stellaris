/// An item of a channel's stream, as the web's `ChannelView` lays it out: a message, or a thread
/// where it was opened.
public enum ChannelItem: Sendable, Hashable, Identifiable {
  case message(Message)
  case thread(ThreadSummary)

  public var id: String {
    switch self {
    case .message(let message): message.id
    case .thread(let summary): summary.id
    }
  }

  /// When the item happened: a message's time, or when a thread was opened.
  public var at: String {
    switch self {
    case .message(let message): message.ts
    case .thread(let summary): summary.thread.openedAt
    }
  }
}

/// A channel's messages with each thread opened on it, in time order, then by id, as the web's
/// `ChannelView` orders them, comparing by UTF-16 code units as the sky does.
public func channelStream(_ channel: String, messages: [Message], threads: [ThreadSummary])
  -> [ChannelItem]
{
  let items =
    messages.map(ChannelItem.message)
    + threads.filter { $0.thread.channel == channel }.map(ChannelItem.thread)
  return items.sorted { a, b in
    a.at != b.at ? sortsBefore(a.at, b.at) : sortsBefore(a.id, b.id)
  }
}

/// A markdown text's first paragraph that isn't a heading, as plain words cut at `limit` UTF-16
/// code units with an ellipsis, as the web's `firstParagraph` gives a closed thread's summary: its
/// paragraphs are what lines of white space alone part, and its plain words lose `*`, `_`, `` ` ``,
/// and `>` and keep one space for each run of white space.
public func firstParagraph(_ markdown: String, limit: Int = 220) -> String {
  var blocks: [[Substring.UnicodeScalarView]] = [[]]
  for line in Substring(markdown).unicodeScalars.split(
    separator: "\n", omittingEmptySubsequences: false)
  {
    if line.allSatisfy(isJavaScriptSpace) {
      blocks.append([])
    } else {
      blocks[blocks.count - 1].append(line)
    }
  }
  let paragraph =
    blocks.lazy.map { lines in
      trimmedAsJavaScript(Substring.UnicodeScalarView(lines.joined(separator: ["\n"])))
    }
    .first { !$0.isEmpty && $0.first != "#" } ?? Substring.UnicodeScalarView()
  let words = paragraph.filter { !"*_`>".unicodeScalars.contains($0) }
    .split(whereSeparator: isJavaScriptSpace)
  let plain = words.map { String(String.UnicodeScalarView($0)) }.joined(separator: " ")
  guard plain.utf16.count > limit else {
    return plain
  }
  let cut = String(decoding: Array(plain.utf16.prefix(limit - 1)), as: UTF16.self)
  let kept = cut.unicodeScalars.lastIndex { !isJavaScriptSpace($0) }
  return (kept.map { String(cut.unicodeScalars[...$0]) } ?? "") + "…"
}
