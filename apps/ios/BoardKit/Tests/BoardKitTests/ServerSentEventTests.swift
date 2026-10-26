import Foundation
import Testing

@testable import BoardKit

@Suite struct ServerSentEventTests {
  private func events(_ text: String, chunk: Int = .max) -> [ServerSentEvent] {
    var parser = ServerSentEventParser()
    let bytes = Array(text.utf8)
    return stride(from: 0, to: bytes.count, by: min(chunk, bytes.count)).flatMap {
      parser.push(contentsOf: bytes[$0..<min($0 + chunk, bytes.count)])
    }
  }

  /// The stream the server wrote in the fixtures' society, read whole and in pieces of any size.
  @Test(arguments: [Int.max, 1, 2, 3, 7, 64])
  func readsTheServersStream(chunk: Int) throws {
    let text = try #require(try Fixture("event-stream").text)
    let frames = events(text, chunk: chunk)
    #expect(frames.count == text.components(separatedBy: "\n\n").count - 1)
    #expect(frames.count > 30)
    for frame in frames {
      let event = try JSONDecoder().decode(BoardEvent.self, from: Data(frame.data.utf8))
      #expect(frame.event == event.type)
      #expect(frame.id == event.id)
    }
  }

  @Test func joinsDataLinesAndDropsOneSpace() {
    #expect(events("data: a\ndata:b\ndata:  c\n\n").map(\.data) == ["a\nb\n c"])
  }

  @Test func endsLinesAtCRLFLFOrCR() {
    let text = "data: one\r\n\r\ndata: two\n\ndata: three\r\r"
    #expect(events(text).map(\.data) == ["one", "two", "three"])
    // A CR that ends one piece and the LF that starts the next are one line end.
    #expect(events(text, chunk: 10).map(\.data) == ["one", "two", "three"])
  }

  @Test func skipsCommentsAndUnknownFields() {
    #expect(events(": hello\nretry: 10\nfoo: bar\ndata: x\n\n").map(\.data) == ["x"])
  }

  @Test func readsAPingAsAnEventWithoutData() {
    #expect(
      events("event: ping\ndata: \n\n") == [ServerSentEvent(id: nil, event: "ping", data: "")])
  }

  @Test func dispatchesNothingForABlockWithoutData() {
    #expect(events("event: ping\n\n").isEmpty)
  }

  @Test func keepsTheLastIdAcrossEvents() {
    let read = events("id: 7\n\ndata: a\n\nid: 8\ndata: b\n\nid: x\0y\ndata: c\n\n")
    #expect(read.map(\.id) == ["7", "8", "8"])
  }

  @Test func readsCharactersSplitAcrossPieces() {
    #expect(events("data: étoile ✶\n\n", chunk: 1).map(\.data) == ["étoile ✶"])
  }

  @Test func holdsAnUnfinishedEvent() {
    #expect(events("data: a\n").isEmpty)
  }
}
