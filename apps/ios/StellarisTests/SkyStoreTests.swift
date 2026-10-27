import BoardKit
import Foundation
import Synchronization
import Testing

@testable import Stellaris

/// The scheduler's answer as a test sets it, in front of the fake board, which answers the rest: the
/// scheduler's queue changes with no event, as when a wake waits for a free slot.
final class ChangingScheduler: URLProtocol {
  static let idle = #"{"paused":false,"running":[],"pending":[],"resident":[]}"#
  static let answer = Mutex(idle)

  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host() == FakeBoard.address.host()
      && request.url?.path(percentEncoded: true) == "/api/scheduler"
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])
    else {
      return
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(ChangingScheduler.answer.withLock { $0 }.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

/// The sky's store against the fake board: what it loads, what a failure shows, the project it
/// frames, what a touch and the gestures do, what the turn stream raises, and how a post's ids
/// read.
@MainActor @Suite(.serialized) struct SkyStoreTests {
  private let board = FakeBoard.address
  private let view = SkyViewport(width: 475, height: 669)

  private func signedIn() async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: board, token: "fixture-token")
    try await waitUntilLoaded(model)
    return model
  }

  /// Signed in to the fake board with the scheduler's answer from `ChangingScheduler`.
  private func signedInChangingTheScheduler() async throws -> AppModel {
    let defaults = UserDefaults(suiteName: "sky-\(UUID().uuidString)")!
    var environment = FakeBoard.environment(folder: fixturesFolder, defaults: defaults)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChangingScheduler.self, FakeBoard.self]
    environment.session = URLSession(configuration: configuration)
    environment.tokens = MemoryTokens()
    let model = AppModel(environment: environment)
    await model.start()
    try await model.signIn(board: board, token: "fixture-token")
    try await waitUntilLoaded(model)
    return model
  }

  /// Waits up to `seconds` for `done`.
  private func wait(seconds: Int, until done: () -> Bool) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now + .seconds(seconds)
    while !done(), clock.now < deadline {
      try await Task.sleep(for: .milliseconds(50))
    }
  }

  /// The sample sky stepped once with Reduce Motion, so everything stands where the model puts it.
  private func settledSample() -> AppModel {
    let model = SkySample.app()
    let sky = model.sky
    sky.viewport = view
    sky.scene.reducedMotion = true
    sky.scene.setModel(sky.model(projects: model.store.projects, tasks: model.store.tasks))
    sky.scene.step(at: 1, in: view)
    sky.lastFrame = sky.scene.frame(in: view, ambient: false, hovered: nil, paused: false)
    sky.publishCamera()
    return model
  }

  @Test func loadsTheRosterAndTheScheduler() async throws {
    let model = try await signedIn()
    await model.sky.load(using: model)
    #expect(model.sky.state == .loaded)
    #expect(model.sky.members.map(\.name) == ["concierge-1", "eng-1", "rev-1", "user"])
    let sky = model.sky.model(projects: model.store.projects, tasks: model.store.tasks)
    #expect(sky.anchors.map(\.id) == [societyScope, "demo"])
    #expect(sky.tasks.map(\.title) == ["Add the export view", "Fix the empty state"])
  }

  /// A roster the board can't give leaves the sky saying so, with Retry.
  @Test(.timeLimit(.minutes(1))) func saysWhenTheRosterFailsToLoad() async throws {
    let gate = HeldBoard.Gate(paths: ["/api/members"])
    let (model, _) = fakeApp(holding: gate)
    await model.start()
    try await model.signIn(board: board, token: gate.token)
    let loading = Task { await model.sky.load(using: model) }
    await gate.arrivals(1)
    #expect(model.sky.state == .loading)
    gate.fail()
    await loading.value
    #expect(model.sky.state == .failed(Loading.unreachable))
  }

  /// The sky frames the project of the conversation Chat shows: one of its channels, or a thread
  /// in one once its task is known.
  @Test func framesTheProjectChatShows() async throws {
    let model = try await signedIn()
    #expect(model.skyFocus == nil)
    model.open(.channel("demo/general"))
    #expect(model.skyFocus == "demo")
    model.open(.thread("00000000000000000000000010"))
    #expect(model.skyFocus == "demo")
    model.open(.channel("governance"))
    #expect(model.skyFocus == nil)
  }

  /// A tap opens the card of the star, the task's mark, or the sphere under it, and one on empty
  /// sky closes it.
  @Test func aTapOpensTheCardOfWhatItTook() throws {
    let model = settledSample()
    let sky = model.sky
    let frame = try #require(sky.lastFrame)
    let star = try #require(frame.stars.first { $0.id == "eng-1/demo" })
    sky.tap(at: star.center)
    #expect(sky.card == .star("eng-1/demo"))
    let mark = try #require(frame.marks.first { $0.id == SkySample.id(2) })
    sky.tap(at: mark.center)
    #expect(sky.card == .task(SkySample.id(2)))
    sky.tap(at: SkyPoint(x: 2, y: 2))
    #expect(sky.card == nil)
  }

  /// A zoom and a drag leave the camera where the user put it, which VoiceOver describes, and the
  /// Fit its camera element offers takes it home.
  @Test func theGesturesMoveTheCameraAndFitTakesItHome() {
    let model = settledSample()
    let sky = model.sky
    #expect(SkyElements.describe(sky.camera, model: model) == "Whole sky")
    sky.zoom(by: 2)
    #expect(sky.camera.mode == .manual)
    #expect(SkyElements.describe(sky.camera, model: model) == "200%, centred on 0, 0")
    sky.pan(dx: 40, dy: 0)
    let panned = SkyElements.describe(sky.camera, model: model)
    #expect(panned.hasPrefix("200%, centred on -") && panned.hasSuffix(", 0"))
    sky.home()
    #expect(sky.camera.mode == .home)
    #expect(SkyElements.describe(sky.camera, model: model) == "Whole sky")
  }

  /// A wake queued with no event to say so shows its citizen queued all the same, as the web's sky
  /// shows it by asking the scheduler every three seconds.
  @Test(.timeLimit(.minutes(1))) func followsTheSchedulersQueueWithNoEvent() async throws {
    ChangingScheduler.answer.withLock { $0 = ChangingScheduler.idle }
    defer { ChangingScheduler.answer.withLock { $0 = ChangingScheduler.idle } }
    let model = try await signedInChangingTheScheduler()
    let running = Task { await model.sky.run(using: model) }
    defer { running.cancel() }
    try await wait(seconds: 10) { model.sky.state == .loaded }
    #expect(model.sky.scheduler?.pending == [])

    ChangingScheduler.answer.withLock {
      $0 = #"{"paused":false,"running":[],"pending":["rev-1/demo"],"resident":[]}"#
    }
    try await wait(seconds: 10) { model.sky.scheduler?.pending == ["rev-1/demo"] }
    #expect(model.sky.scheduler?.pending == ["rev-1/demo"])
    let sky = model.sky.model(projects: model.store.projects, tasks: model.store.tasks)
    #expect(sky.stars.first { $0.name == "rev-1" }?.state == .queued)
  }

  struct TitlesCase: Decodable {
    let name: String
    let text: String
    let titles: [String: String]
    let line: String
  }

  /// A post's task ids read as their titles where the web's `withTitles` reads them, over the cases
  /// in `apps/ios/fixtures/cases` the web runs too: an id standing alone, never one in a path or a
  /// file name, and a title it echoes said once.
  @Test func readsTaskIdsInALineAsTheWebDoes() throws {
    let table = fixturesFolder.deletingLastPathComponent().appendingPathComponent(
      "cases/with-titles.json")
    let cases = try JSONDecoder().decode([TitlesCase].self, from: Data(contentsOf: table))
    #expect(cases.count > 10)
    let (model, _) = fakeApp()
    for each in cases {
      model.store.show(projects: [], tasks: SkySample.tasks(titled: each.titles))
      #expect(model.store.withTaskTitles(each.text) == each.line, "\(each.name)")
    }
  }

  /// A pinch that ends at or past the whole sky's zoom goes back to the whole sky, which follows the
  /// society again; one that ends zoomed in stays where it was.
  @Test func aPinchOutToTheWholeSkyGoesHome() {
    let model = settledSample()
    let sky = model.sky
    sky.pan(dx: 60, dy: -30)
    sky.zoom(by: 2)
    sky.endPinch()
    #expect(sky.camera.mode == .manual)
    sky.zoom(by: 0.4)
    sky.endPinch()
    #expect(sky.camera.mode == .home)
    #expect(SkyElements.describe(sky.camera, model: model) == "Whole sky")
  }

  /// The fake board's turn stream, the captured one stamped now: the post's first line rises from
  /// its author's star and stays known as its last, and a call that posts nothing raises no line.
  @Test(.timeLimit(.minutes(1))) func theTurnStreamRaisesAPostsLine() async throws {
    let model = try await signedIn()
    let running = Task { await model.sky.run(using: model) }
    defer { running.cancel() }
    let clock = ContinuousClock()
    let deadline = clock.now + .seconds(20)
    while model.sky.lastSaid["eng-1"] == nil, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(50))
    }
    #expect(model.sky.lastSaid == ["eng-1": "The export view is in"])
    #expect(model.sky.state == .loaded)
  }
}
