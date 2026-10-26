/// One event of a server-sent-events stream.
public struct ServerSentEvent: Sendable, Hashable {
  /// The stream's last event id when the event was dispatched.
  public let id: String?
  /// The event's type, or nil for the default, `message`.
  public let event: String?
  /// The data lines, joined with newlines; empty for the board's keep-alive pings.
  public let data: String
}

/// Reads a server-sent-events stream byte by byte, as the WHATWG HTML standard's event-stream
/// interpretation does: a byte order mark at the stream's start is dropped, lines end at CRLF, LF,
/// or CR, a blank line dispatches the event, a line starting with a colon is a comment, and one
/// space after a field's colon is dropped.
public struct ServerSentEventParser: Sendable {
  private static let byteOrderMark: [UInt8] = [0xEF, 0xBB, 0xBF]

  private var line: [UInt8] = []
  private var firstLine = true
  private var afterCarriageReturn = false
  private var data = ""
  private var hasData = false
  private var type: String?
  private var lastId: String?

  public init() {}

  /// Takes the stream's next byte; returns the event it completes, if any.
  public mutating func push(_ byte: UInt8) -> ServerSentEvent? {
    let skipped = afterCarriageReturn && byte == 0x0A
    afterCarriageReturn = byte == 0x0D
    if skipped {
      return nil
    }
    guard byte == 0x0A || byte == 0x0D else {
      line.append(byte)
      return nil
    }
    if firstLine, line.starts(with: ServerSentEventParser.byteOrderMark) {
      line.removeFirst(ServerSentEventParser.byteOrderMark.count)
    }
    firstLine = false
    let text = String(decoding: line, as: UTF8.self)
    line.removeAll(keepingCapacity: true)
    return process(text)
  }

  /// Takes the stream's next bytes; returns the events they complete, in order.
  public mutating func push(contentsOf bytes: some Sequence<UInt8>) -> [ServerSentEvent] {
    bytes.compactMap { push($0) }
  }

  private mutating func process(_ line: String) -> ServerSentEvent? {
    if line.isEmpty {
      return dispatch()
    }
    if line.hasPrefix(":") {
      return nil
    }
    let field: Substring
    var value: Substring
    if let colon = line.firstIndex(of: ":") {
      field = line[..<colon]
      value = line[line.index(after: colon)...]
      if value.hasPrefix(" ") {
        value = value.dropFirst()
      }
    } else {
      field = line[...]
      value = ""
    }
    switch field {
    case "event":
      type = String(value)
    case "data":
      data += hasData ? "\n" + value : value
      hasData = true
    case "id" where !value.contains("\0"):
      lastId = String(value)
    default:
      break
    }
    return nil
  }

  private mutating func dispatch() -> ServerSentEvent? {
    defer {
      data = ""
      hasData = false
      type = nil
    }
    guard hasData else {
      return nil
    }
    return ServerSentEvent(id: lastId, event: type?.isEmpty == false ? type : nil, data: data)
  }
}
