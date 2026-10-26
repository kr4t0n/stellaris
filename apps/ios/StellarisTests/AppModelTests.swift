import BoardKit
import Foundation
import Synchronization
import Testing

@testable import Stellaris

/// The folder of answers the server's tests captured, beside this one.
let fixturesFolder = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()  // StellarisTests
  .deletingLastPathComponent()  // ios
  .appendingPathComponent("fixtures/api")

/// Tokens kept in memory in place of the Keychain.
final class MemoryTokens: TokenKeeping {
  private let tokens = Mutex<[URL: String]>([:])

  func token(for board: URL) throws -> String? { tokens.withLock { $0[board] } }
  func save(_ token: String, for board: URL) throws { tokens.withLock { $0[board] = token } }
  func delete(for board: URL) throws { tokens.withLock { $0[board] = nil } }
}

/// The app against the fake board, with tokens in memory and defaults of its own, and behind
/// `gate` when one is given.
@MainActor func fakeApp(holding gate: HeldBoard.Gate? = nil) -> (AppModel, MemoryTokens) {
  // A suite name other than the app's own always makes defaults.
  let defaults = UserDefaults(suiteName: "app-\(UUID().uuidString)")!
  var environment = FakeBoard.environment(folder: fixturesFolder, defaults: defaults)
  if let gate {
    environment.session = gate.session
  }
  let tokens = MemoryTokens()
  environment.tokens = tokens
  return (AppModel(environment: environment), tokens)
}

struct NotLoaded: Error {}

/// Waits up to ten seconds for the board to have loaded, as the load signing in starts does.
@MainActor func waitUntilLoaded(_ model: AppModel) async throws {
  let clock = ContinuousClock()
  let deadline = clock.now + .seconds(10)
  while model.store.state != .loaded {
    guard clock.now < deadline else {
      throw NotLoaded()
    }
    try await Task.sleep(for: .milliseconds(20))
  }
}

@MainActor @Suite(.serialized) struct AppModelTests {
  private let board = FakeBoard.address

  @Test func signsInWithATokenTheBoardTakes() async throws {
    let (model, tokens) = fakeApp()
    await model.start()
    #expect(model.phase == .signedOut)
    try await model.signIn(board: board, token: "fixture-token")
    #expect(model.phase == .signedIn)
    #expect(model.actor?.name == "user")
    #expect(try tokens.token(for: board) == "fixture-token")
    #expect(model.history.current == .general)
    await model.refresh()
    #expect(model.store.state == .loaded)
    #expect(model.store.attention.count == 6)
  }

  @Test func keepsNothingOfATokenTheBoardRefuses() async throws {
    let (model, tokens) = fakeApp()
    await model.start()
    await #expect(throws: SignInFailure.refused) {
      try await model.signIn(board: board, token: "refused")
    }
    #expect(model.phase == .signedOut)
    #expect(try tokens.token(for: board) == nil)
  }

  /// A 401 on any request after sign-in sends the app back to sign-in and drops the token.
  @Test func goesBackToSignInWhenTheBoardStopsTakingTheToken() async throws {
    let (model, tokens) = fakeApp()
    await model.start()
    try await model.signIn(board: board, token: "revoked")
    await model.refresh()
    #expect(model.phase == .signedOut)
    #expect(model.notice == "The board ended this sign-in.")
    #expect(try tokens.token(for: board) == nil)
    #expect(model.board == board)
  }

  /// A 401 for a request an earlier sign-in made, landing once the app has signed in again, ends
  /// nothing, and the failure it ends in doesn't reach the board the new sign-in loaded.
  @Test(.timeLimit(.minutes(1))) func endsNothingWhenAnEarlierSignInsTokenIsRefused() async throws {
    let gate = HeldBoard.Gate(paths: ["/api/projects/demo/tasks"])
    let (model, tokens) = fakeApp(holding: gate)
    await model.start()
    try await model.signIn(board: board, token: gate.token)
    // The load signing in started, then this one, each held at the project's tasks.
    await gate.arrivals(1)
    let earlier = Task { await model.refresh() }
    await gate.arrivals(2)
    await model.signOut()
    try await model.signIn(board: board, token: "fixture-token")
    try await waitUntilLoaded(model)

    gate.refuse()
    await earlier.value
    #expect(model.phase == .signedIn)
    #expect(model.notice == nil)
    #expect(try tokens.token(for: board) == "fixture-token")
    #expect(model.store.state == .loaded)
  }

  /// What a refresh an earlier sign-in started brings back once the app has signed out leaves the
  /// board empty.
  @Test(.timeLimit(.minutes(1))) func dropsWhatAnEarlierSignInsRefreshBringsBack() async throws {
    let gate = HeldBoard.Gate(paths: ["/api/projects/demo/tasks"])
    let (model, _) = fakeApp(holding: gate)
    await model.start()
    try await model.signIn(board: board, token: gate.token)
    await gate.arrivals(1)
    let earlier = Task { await model.refresh() }
    await gate.arrivals(2)
    await model.signOut()

    gate.answer()
    await earlier.value
    #expect(model.phase == .signedOut)
    #expect(model.store.state == .idle)
    #expect(model.store.channels.isEmpty)
    #expect(model.store.tasks.isEmpty)
    #expect(model.store.attention.isEmpty)
  }

  /// Who an earlier sign-in's token signs in as, answered once the app has signed out, isn't taken
  /// as who the app is signed in as.
  @Test(.timeLimit(.minutes(1))) func takesNoOneFromAnEarlierSignInsAnswer() async throws {
    let gate = HeldBoard.Gate(paths: ["/api/me"])
    let (first, _) = fakeApp(holding: gate)
    await first.start()
    let signingIn = Task { try await first.signIn(board: board, token: gate.token) }
    await gate.arrivals(1)
    gate.answer()
    try await signingIn.value

    // A fresh start with the kept token, while the board can't be reached.
    let model = AppModel(environment: first.environment)
    let starting = Task { await model.start() }
    await gate.arrivals(2)
    gate.fail()
    await starting.value
    #expect(model.phase == .signedIn)
    #expect(model.actor == nil)

    let earlier = Task { await model.refresh() }
    await gate.arrivals(3)
    await model.signOut()
    gate.answer()
    await earlier.value
    #expect(model.phase == .signedOut)
    #expect(model.actor == nil)
  }

  /// A fresh start signs in with the kept token and opens the society's general channel, whatever
  /// was open before.
  @Test func startsAfreshOnGeneralWithTheKeptToken() async throws {
    let (model, tokens) = fakeApp()
    await model.start()
    try await model.signIn(board: board, token: "fixture-token")
    model.open(.thread("00000000000000000000000010"))
    model.memory?.setDraft("Half a thought", for: .general)

    let relaunched = AppModel(environment: model.environment)
    await relaunched.start()
    #expect(relaunched.phase == .signedIn)
    #expect(relaunched.history.current == .general)
    #expect(relaunched.memory?.draft(.general) == "Half a thought")
    #expect(try tokens.token(for: board) == "fixture-token")
  }

  @Test func opensWhatBoardPicksInChatAndGoesBack() async throws {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: board, token: "fixture-token")
    model.tab = .board
    let task = Conversation.thread("00000000000000000000000010")
    model.open(task)
    #expect(model.tab == .chat)
    #expect(model.back == .general)
    await model.feed(for: task).load(using: model)
    #expect(model.name(of: task) == "Add the export view")
    model.goBack()
    #expect(model.history.current == .general)
    #expect(model.back == nil)
  }

  /// Back from a thread opened with nothing before it goes to the thread's channel, once loaded.
  @Test func sendsAThreadBackToItsChannel() async throws {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: board, token: "fixture-token")
    let thread = Conversation.thread("00000000000000000000000010")
    let feed = model.feed(for: thread)
    await feed.load(using: model)
    #expect(feed.thread?.channel == "demo/general")
    #expect(ChatHistory(current: thread).back(threadChannel: feed.thread?.channel)
      == .channel("demo/general"))
  }

  @Test func signsOutAndForgetsTheDrafts() async throws {
    let (model, tokens) = fakeApp()
    await model.start()
    try await model.signIn(board: board, token: "fixture-token")
    model.memory?.setDraft("Half a thought", for: .general)
    await model.signOut()
    #expect(model.phase == .signedOut)
    #expect(model.notice == nil)
    #expect(try tokens.token(for: board) == nil)
    try await model.signIn(board: board, token: "fixture-token")
    #expect(model.memory?.draft(.general) == "")
  }
}
