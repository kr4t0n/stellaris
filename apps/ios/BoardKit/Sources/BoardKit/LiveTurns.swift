// The live turn stream as the sky reads it: each event the server streams from `/api/turns/stream`
// (`LiveTurnEventSchema` in `packages/shared`), and the motion an event sets off in the sky, a port
// of the listener in the web's `apps/web/src/sky/Sky.tsx` with `postedLine` and `toolLabel` from
// `apps/web/src/lib/live.ts`. `postedLine` runs the case table in `apps/ios/fixtures/cases`, which
// the web's own test runs too.

import Foundation

/// What a citizen's turn did, as far as the sky reads it: a tool's call, or a step of any other
/// type, which it leaves be.
public enum AgentEvent: Sendable, Hashable, Decodable {
  case toolCall(name: String, input: JSONValue)
  case other(type: String)

  private enum CodingKeys: String, CodingKey {
    case type, name, input
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    if type == "tool_call" {
      self = .toolCall(
        name: try container.decode(String.self, forKey: .name),
        input: try container.decodeIfPresent(JSONValue.self, forKey: .input) ?? .null)
    } else {
      self = .other(type: type)
    }
  }
}

/// One step of a turn as the server streams it live: which citizen took it, in which scope (a
/// project's slug or the society's), numbered in a sequence that starts over with the server.
public struct LiveTurnEvent: Sendable, Hashable, Decodable {
  public let seq: Int
  public let ts: String
  public let agent: String
  /// The scope: a project's slug, or the society's.
  public let project: String
  /// The thread whose conversation the turn is in; nil for the home conversation.
  public let thread: String?
  /// The channel, never general, whose conversation the turn is in.
  public let channel: String?
  /// The project whose channels' conversation the turn is in, for a turn in the society scope.
  public let place: String?
  public let event: AgentEvent
}

/// A tool's name as the board's views show it: a board verb by its own name, another MCP server's
/// tool as `server:tool`, and anything else as it is.
public func toolLabel(_ name: String) -> String {
  guard name.hasPrefix("mcp__") else {
    return name
  }
  let rest = name.dropFirst("mcp__".count)
  // As the web's `/^mcp__(.+?)__(.+)$/`: the server's name is the shortest that leaves a tool.
  var search = rest.index(rest.startIndex, offsetBy: 1, limitedBy: rest.endIndex) ?? rest.endIndex
  while let separator = rest[search...].range(of: "__") {
    let server = rest[..<separator.lowerBound]
    let tool = rest[separator.upperBound...]
    if !tool.isEmpty {
      return server == "board" ? String(tool) : "\(server):\(tool)"
    }
    search = rest.index(after: separator.lowerBound)
  }
  return name
}

/// How long a bubble's line may be, in UTF-16 code units as the web counts a string's length.
private let summaryLimit = 400

/// What JavaScript's `\s` and `trim` take for white space.
func isJavaScriptSpace(_ scalar: Unicode.Scalar) -> Bool {
  switch scalar.value {
  case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
    0xFEFF:
    true
  default:
    false
  }
}

func trimmedAsJavaScript(_ scalars: Substring.UnicodeScalarView)
  -> Substring.UnicodeScalarView
{
  guard let first = scalars.firstIndex(where: { !isJavaScriptSpace($0) }),
    let last = scalars.lastIndex(where: { !isJavaScriptSpace($0) })
  else {
    return Substring.UnicodeScalarView()
  }
  return scalars[first...last]
}

/// The first line of a post that `post_message` posts, without the marks a heading, a quote, or a
/// list item starts with, for the bubble that rises from its author's star; nil for any other
/// tool, and for a post with no words.
public func postedLine(name: String, input: JSONValue) -> String? {
  guard toolLabel(name) == "post_message", let body = input["body"]?.string else {
    return nil
  }
  // By scalars, as the web splits at each line feed: Swift's characters hold a CRLF as one.
  let first =
    Substring(body).unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false)
    .map(trimmedAsJavaScript)
    .first { !$0.isEmpty } ?? Substring.UnicodeScalarView()
  let marks = first.prefix {
    $0 == "#" || $0 == ">" || $0 == "*" || $0 == "-" || isJavaScriptSpace($0)
  }
  let line = String(String.UnicodeScalarView(first.dropFirst(marks.count)))
  guard !line.isEmpty else {
    return nil
  }
  guard line.utf16.count > summaryLimit else {
    return line
  }
  return String(decoding: Array(line.utf16.prefix(summaryLimit - 1)), as: UTF16.self) + "…"
}

/// Events older than this are the server's buffer replayed on connect, not motion now. Measured on
/// the device's clock against the server's stamps, so it allows for some drift between the two.
public let recentTurnEvents: TimeInterval = 15

/// What a live event sets off in the sky: the star that flickers, and the line that rises from it
/// when the event posts one.
public struct SkyCue: Sendable, Hashable {
  public let star: String
  public let line: String?

  public init(star: String, line: String?) {
    self.star = star
    self.line = line
  }
}

/// The motion `item` sets off in `model` at `now`: a tool's call flickers its citizen's star, and
/// a post's first line rises from it. Nil for any other step, for an event older than
/// `recentTurnEvents`, whose stamp can't be read, and for a citizen the sky doesn't show.
public func skyCue(for item: LiveTurnEvent, in model: SkyModel, now: Date) -> SkyCue? {
  guard case .toolCall(let name, let input) = item.event,
    let stamped = parseBoardTime(item.ts),
    now.timeIntervalSince(stamped) <= recentTurnEvents,
    let star = starOf(model, agent: item.agent, scope: item.project)
  else {
    return nil
  }
  return SkyCue(star: star, line: postedLine(name: name, input: input))
}

/// A time as the board stamps it, `2026-10-27T08:00:00.000Z`, with or without its fraction.
public func parseBoardTime(_ text: String) -> Date? {
  let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
  return (try? withFraction.parse(text)) ?? (try? Date.ISO8601FormatStyle().parse(text))
}
