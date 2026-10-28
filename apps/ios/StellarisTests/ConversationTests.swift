import BoardKit
import Foundation
import Testing

@testable import Stellaris

/// Talking in a conversation over the fake board: posting, opening a thread, what an event makes
/// the app read again, the message a link names, and the citizens a mention offers. Each test signs
/// in with a token of its own, which the fake board keeps its writes under.
@MainActor @Suite(.serialized) struct ConversationTests {
  private func signedIn() async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: "talk-\(UUID().uuidString)")
    try await waitUntilLoaded(model)
    return model
  }

  /// Waits up to five seconds for `done`.
  private func eventually(_ done: () -> Bool) async throws -> Bool {
    for _ in 0..<100 where !done() {
      try await Task.sleep(for: .milliseconds(50))
    }
    return done()
  }

  private func event(_ type: String, _ payload: [String: String]) throws -> BoardEvent {
    let object: [String: Any] = [
      "id": "00000000000000000000000Z01", "ts": "2026-01-01T00:00:00.000Z", "type": type,
      "actor": "eng-1", "payload": payload,
    ]
    return try JSONDecoder().decode(
      BoardEvent.self, from: JSONSerialization.data(withJSONObject: object))
  }

  @Test func postsToAChannelAndToAThread() async throws {
    let model = try await signedIn()
    let general = model.feed(for: .general)
    await general.load(using: model)
    let posted = try await model.post("Ship it", to: .general)
    #expect(posted.author == "user" && posted.channel == "general" && posted.thread == nil)
    #expect(try await eventually { general.messages.last?.body == "Ship it" })

    let samples = Conversation.thread(FakeBoard.samples)
    await model.feed(for: samples).load(using: model)
    let reply = try await model.post("Looks right", to: samples)
    #expect(reply.thread == FakeBoard.samples)
    #expect(try await eventually { model.feed(for: samples).messages.last?.id == reply.id })
    #expect(general.messages.last?.body == "Ship it", "the thread's reply went to the channel")
  }

  @Test func opensAThreadWithItsFirstMessageAndShowsIt() async throws {
    let model = try await signedIn()
    model.startingThread = "general"
    model.newThreads["general"] = NewThreadDraft(title: "  Release checklist ", body: "Docs first.")
    try await model.openThread(in: "general")
    guard case .thread(let id) = model.history.current else {
      Issue.record("Chat shows \(model.history.current), not the thread")
      return
    }
    #expect(model.startingThread == nil)
    #expect(model.newThreads["general"] == nil)
    #expect(model.store.threads.contains { $0.id == id && $0.thread.title == "Release checklist" })
    let feed = model.feed(for: .thread(id))
    await feed.load(using: model)
    #expect(feed.messages.map(\.body) == ["Docs first."])
    #expect(model.name(of: .thread(id)) == "Release checklist")
    // The channel's stream holds it where it was opened, at its foot.
    await model.feed(for: .general).load(using: model)
    let stream = channelStream(
      "general", messages: model.feed(for: .general).messages, threads: model.store.threads)
    #expect(stream.last?.id == id)
  }

  @Test func keepsANewThreadsTextUntilItOpensOrIsCancelled() async throws {
    let model = try await signedIn()
    model.startingThread = "general"
    model.newThreads["general"] = NewThreadDraft(title: "Half a title", body: "")
    // Dismissed, as a swipe down or a fold that builds the sheet again does.
    model.startingThread = nil
    model.startingThread = "general"
    #expect(model.newThreads["general"]?.title == "Half a title")
    #expect(model.newThreads["demo/general"] == nil)
  }

  @Test func readsAgainWhatAnEventMadeStale() async throws {
    let model = try await signedIn()
    model.live.settle = .milliseconds(10)
    let general = model.feed(for: .general)
    await general.load(using: model)
    let samples = Conversation.thread(FakeBoard.samples)
    await model.feed(for: samples).load(using: model)

    // Posted from elsewhere: nothing reads the conversation again until the board says so.
    _ = try await model.send(BoardAPI.postMessage(channel: "general", body: "From elsewhere"))
    #expect(general.messages.last?.body != "From elsewhere")
    let posted = try event("message.posted", ["channel": "general"])
    model.live.take(staleKeys(for: posted), using: model)
    #expect(try await eventually { general.messages.last?.body == "From elsewhere" })

    // A conversation Chat doesn't show is read again when it is next shown.
    _ = try await model.send(BoardAPI.postMessage(thread: FakeBoard.samples, body: "In the thread"))
    let reply = try event("message.posted", ["channel": "general", "thread": FakeBoard.samples])
    model.live.take(staleKeys(for: reply), using: model)
    let thread = model.feed(for: samples)
    #expect(try await eventually { thread.stale })
    #expect(thread.messages.last?.body != "In the thread")
    model.open(samples)
    _ = try await model.send(BoardAPI.postMessage(thread: FakeBoard.samples, body: "Shown"))
    model.live.take(staleKeys(for: reply), using: model)
    #expect(try await eventually { thread.messages.last?.body == "Shown" })
    #expect(!thread.stale)

    let opened = try await model.send(BoardAPI.openThread(channel: "general", title: "Elsewhere"))
    #expect(!model.store.threads.contains { $0.id == opened.id })
    model.live.take(
      staleKeys(for: try event("thread.opened", ["threadId": opened.id])), using: model)
    #expect(try await eventually { model.store.threads.contains { $0.id == opened.id } })
  }

  /// After a drop, events may have been missed, so everything the app shows is read again.
  @Test func readsEverythingAgainAfterADrop() async throws {
    let model = try await signedIn()
    model.live.settle = .milliseconds(10)
    let general = model.feed(for: .general)
    await general.load(using: model)
    _ = try await model.send(BoardAPI.postMessage(channel: "general", body: "Missed"))
    let opened = try await model.send(BoardAPI.openThread(channel: "general", title: "Missed too"))
    model.live.takeEverything(using: model)
    #expect(try await eventually { general.messages.last?.body == "Missed" })
    #expect(try await eventually { model.store.threads.contains { $0.id == opened.id } })
  }

  @Test func marksTheMessageALinkNamesUntilTheConversationOpensAnotherWay() async throws {
    let model = try await signedIn()
    model.open(.thread(FakeBoard.samples))
    let note = FakeBoard.generalId(30)
    let link = try #require(URL(string: "/c/general?message=\(note)"))
    #expect(model.follow(link) == .opened)
    #expect(model.history.current == .general)
    #expect(model.marks[.general] == MessageMark(id: note))
    model.reachedMark(in: .general)
    #expect(model.marks[.general]?.reached == true)
    // Back keeps it; opened from Board, the conversation has none.
    model.goBack()
    model.goBack()
    #expect(model.history.current == .general)
    #expect(model.marks[.general]?.id == note)
    model.open(.general)
    #expect(model.marks[.general] == nil)
  }

  @Test func offersActiveCitizensWithACliToMention() async throws {
    let model = try await signedIn()
    #expect(model.store.mentionable("").map(\.name) == ["concierge-1", "eng-1", "rev-1"])
    #expect(model.store.mentionable("e").map(\.name) == ["eng-1"])
    #expect(model.store.mentionable("eng-1x").isEmpty)
    #expect(model.store.readOnly("general") == nil)
  }
}
