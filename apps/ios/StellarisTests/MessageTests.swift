import BoardKit
import Foundation
import Testing
import UIKit

@testable import Stellaris

/// What a message's links, ids, and images do, over the fake board.
@MainActor @Suite(.serialized) struct MessageTests {
  private let task = "00000000000000000000000010"

  private func signedIn() async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: "fixture-token")
    try await waitUntilLoaded(model)
    return model
  }

  @Test func opensWhatTheBoardNamesInChatAndTheRestInSafari() async throws {
    let model = try await signedIn()
    let message = "00000000000000000000000020"
    #expect(model.follow(try #require(URL(string: "/task/\(task)"))) == .opened)
    #expect(model.history.current == .thread(task))
    #expect(model.follow(try #require(URL(string: "/proposal/\(message)"))) == .opened)
    #expect(model.history.current == .thread(message))
    #expect(
      model.follow(try #require(URL(string: "/thread/\(task)?message=\(message)"))) == .opened)
    #expect(model.history.current == .thread(task))
    let inChannel = try #require(URL(string: "/c/demo/general?message=\(message)"))
    #expect(model.follow(inChannel) == .opened)
    #expect(model.history.current == .channel("demo/general"))
    let cron = try #require(URL(string: "/crons?cron=\(message)"))
    let page = try #require(URL(string: "https://board.example.com/crons?cron=\(message)"))
    #expect(model.follow(cron) == .safari(page))
    let web = try #require(URL(string: "https://example.com/specs/export"))
    #expect(model.follow(web) == .safari(web))
    #expect(model.follow(try #require(URL(string: "mailto:a@example.com"))) != .nowhere)
    #expect(model.follow(try #require(URL(string: "javascript:alert(1)"))) == .nowhere)
    #expect(model.follow(try #require(URL(string: "notes.md"))) == .nowhere)
  }

  @Test func carriesEachLinkAsTheConversationFollowsIt() throws {
    let entity = MessageLink.entity(EntityLink(kind: .task, id: task))
    #expect(MessageText.url(for: entity)?.relativeString == "/task/\(task)")
    let file = MessageLink.file(source: .task(task), path: "evidence/policy plot.png", line: 12)
    #expect(
      MessageText.url(for: file)?.relativeString
        == "/task/\(task)/files/evidence/policy%20plot.png?line=12")
    let address = MessageText.url(for: .web("//example.com/x"))
    #expect(address?.absoluteString == "https://example.com/x")
    #expect(MessageText.url(for: .web("#top")) == nil)
  }

  @Test func readsIdsAsWhatTheBoardNames() async throws {
    let model = try await signedIn()
    #expect(model.store.entities[task] == EntityTitle(kind: .task, title: "Add the export view"))
    let proposals = model.store.proposals
    #expect(proposals.allSatisfy { model.store.entities[$0.id]?.kind == .proposal })
    #expect(!model.store.threads.isEmpty)
    #expect(model.store.titled("Waiting on \(task).") == "Waiting on Add the export view.")
    let posted = """
      {"id": "m1", "author": "eng-1", "channel": "general", "ts": "2026-01-01T09:00:00.000Z",
       "mentions": [], "body": "Done with \(task)."}
      """
    let message = try JSONDecoder().decode(Message.self, from: Data(posted.utf8))
    let document = model.document(for: message)
    #expect(
      document.blocks == [
        .paragraph([
          .run(MessageRun("Done with ")),
          .run(
            MessageRun(
              "Add the export view", link: .entity(EntityLink(kind: .task, id: task)))),
          .run(MessageRun(".")),
        ])
      ])
    #expect(model.store.cli(of: "eng-1") == .known(.codex))
    #expect(model.store.cli(of: "user") == nil)
    #expect(model.displayName("user") == "you")
  }

  @Test func loadsEachKindOfImageAndKeepsUploadsById() async throws {
    let model = try await signedIn()
    let upload = try await model.images.image(.upload(FakeBoard.uploaded), using: model)
    #expect(upload.size == CGSize(width: 820, height: 492))
    let again = try await model.images.image(.upload(FakeBoard.uploaded), using: model)
    #expect(again === upload)
    let plot = try await model.images.image(
      .file(source: .task(task), path: "evidence/plot.png"), using: model)
    #expect(plot.size == CGSize(width: 600, height: 360))
    let wide = try await model.images.image(
      .web("https://images.example.com/wide.png"), using: model)
    #expect(wide.size == CGSize(width: 1600, height: 400))
    await #expect(throws: (any Error).self) {
      try await model.images.image(.upload(FakeBoard.gone), using: model)
    }
    await #expect(throws: ImageFailure.self) {
      try await model.images.image(.web("http://images.example.com/wide.png"), using: model)
    }
  }
}
