import Foundation
import Testing

@testable import BoardKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

@Suite struct RequestTests {
  private let board = URL(string: "https://board.example")!
  private let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

  @Test func encodesEachPartOfAPathAsTheWebDoes() {
    #expect(BoardAPI.channel("lab/general").endpoint.path == "/api/channels/lab/general")
    #expect(BoardAPI.channel("general").endpoint.path == "/api/channels/general")
    #expect(BoardAPI.task("a/b c").endpoint.path == "/api/tasks/a%2Fb%20c")
    #expect(BoardAPI.tasks(project: "é").endpoint.path == "/api/projects/%C3%A9/tasks")
    #expect(BoardAPI.thread("it's(1)!").endpoint.path == "/api/threads/it's(1)!")
    #expect(BoardAPI.eventStream(since: "latest").path == "/api/events/stream?since=latest")
    #expect(BoardAPI.image(id).path == "/api/images/\(id)")
  }

  @Test func sendsTheTokenAsABearerHeader() {
    let request = BoardAPI.me().endpoint.urlRequest(board: board, token: "secret")
    #expect(request.url?.absoluteString == "https://board.example/api/me")
    #expect(request.httpMethod == "GET")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == nil)
    #expect(request.httpBody == nil)
  }

  @Test func asksHowToSignInWithoutAToken() {
    let request = BoardAPI.authConfig().endpoint.urlRequest(board: board, token: "secret")
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
  }

  @Test func keepsAPathTheBoardsAddressHas() {
    for address in ["https://example.org/stellaris", "https://example.org/stellaris/"] {
      let request = BoardAPI.me().endpoint.urlRequest(board: URL(string: address)!, token: nil)
      #expect(request.url?.absoluteString == "https://example.org/stellaris/api/me")
    }
  }

  @Test func runsAVerbWithItsInputAsJSON() throws {
    let request = BoardAPI.postMessage(channel: "general", body: "Hello")
      .endpoint.urlRequest(board: board, token: "secret")
    #expect(request.httpMethod == "POST")
    #expect(request.url?.path == "/api/verbs/post_message")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    let body = try #require(request.httpBody)
    #expect(String(decoding: body, as: UTF8.self) == #"{"body":"Hello","channel":"general"}"#)
  }

  @Test func postsAnImageAsItsBytesUnderItsName() throws {
    let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1])
    let request = BoardAPI.uploadImage(png, name: "the plot [v2].png").endpoint
      .urlRequest(board: board, token: "secret")
    #expect(request.httpMethod == "POST")
    #expect(
      request.url?.absoluteString
        == "https://board.example/api/images?name=the%20plot%20%5Bv2%5D.png")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "image/png")
    #expect(request.httpBody == png)
    // Bytes of no kind the board keeps go as they are, for the board to refuse in its own words.
    let text = BoardAPI.uploadImage(Data("notes".utf8), name: "notes.txt").endpoint
    #expect(text.contentType == "application/octet-stream")
    // A verb's body is still JSON.
    #expect(BoardAPI.approve(id).endpoint.contentType == "application/json")
  }

  @Test func tellsAnImagesKindByItsFirstBytesAsTheBoardDoes() {
    #expect(imageType(of: Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])) == .png)
    #expect(imageType(of: Data([0xff, 0xd8, 0xff, 0xe0])) == .jpeg)
    #expect(imageType(of: Data("GIF87a".utf8)) == .gif)
    #expect(imageType(of: Data("GIF89a".utf8)) == .gif)
    #expect(imageType(of: Data("RIFF\u{0}\u{0}\u{0}\u{0}WEBPVP8 ".utf8)) == .webp)
    #expect(imageType(of: Data("RIFF\u{0}\u{0}\u{0}\u{0}WAVE".utf8)) == nil)
    #expect(imageType(of: Data("<svg/>".utf8)) == nil)
    #expect(imageType(of: Data([0x89, 0x50, 0x4e])) == nil)
    #expect(imageType(of: Data()) == nil)
    // As a slice of a larger buffer, whose indices don't start at zero.
    let framed = Data([0, 0, 0xff, 0xd8, 0xff, 0xe0])
    #expect(imageType(of: framed[2...]) == .jpeg)
    #expect(ImageType.webp.mediaType == "image/webp")
  }

  @Test func leavesOutWhatTheUserLeftEmpty() throws {
    let approve = try #require(BoardAPI.approve(id).endpoint.body)
    #expect(String(decoding: approve, as: UTF8.self) == #"{"proposal_id":"\#(id)"}"#)
    let advance = try #require(BoardAPI.advanceTask(id, note: nil).endpoint.body)
    #expect(String(decoding: advance, as: UTF8.self) == #"{"task_id":"\#(id)"}"#)
  }

  @Test func runsAnyVerb() throws {
    struct Close: Encodable {
      let thread_id: String
      let summary: String
    }
    let request: BoardRequest<Message> = try BoardAPI.verb(
      "close_thread", Close(thread_id: id, summary: "Done."))
    #expect(request.endpoint.path == "/api/verbs/close_thread")
    #expect(request.endpoint.method == .post)
  }

  @Test func readsARefusalWithoutTheBoardsShape() {
    let error = BoardError(status: 502, body: Data("<html>Bad gateway</html>".utf8))
    #expect(error.code == "HTTP_502")
    #expect(!error.isUnauthorized)
  }
}
