import BoardKit
import SwiftUI
import Synchronization
import UIKit
import XCTest

@testable import Stellaris

/// Answers the scheduler as idle in front of the fake board, counting each time it is asked.
final class CountedScheduler: URLProtocol {
  static let asked = Mutex(0)

  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host() == FakeBoard.address.host()
      && request.url?.path(percentEncoded: true) == "/api/scheduler"
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    CountedScheduler.asked.withLock { $0 += 1 }
    guard let url = request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])
    else {
      return
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(ChangingScheduler.idle.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

/// The app's window as iOS resizes it when the phone opens, turns, and folds again, with the size
/// classes each display gives, since the simulator in CI keeps the inner display closed and its
/// outer display upright. The sky draws beside the chat on the inner display alone, and asks the
/// board nothing while the phone is folded; Chat keeps the conversation, its draft, and the
/// message its scroll is anchored at through every change; and the sky's camera starts at the
/// whole sky and is kept through a fold.
final class FoldTests: XCTestCase {
  /// The outer display, and the inner display in landscape and in portrait.
  private let outer = CGSize(width: 466, height: 678)
  private let landscape = CGSize(width: 951, height: 669)
  private let portrait = CGSize(width: 669, height: 951)
  private let draftText = "Half a thought"
  private let anchored = "general-30"

  @MainActor func testTheChatKeepsItsPlaceAsThePhoneOpensTurnsAndFolds() async throws {
    continueAfterFailure = false
    let model = try await signedIn()
    let memory = try XCTUnwrap(model.memory)
    // The draft and the message the scroll is anchored at, as the user left them.
    memory.setDraft(draftText, for: .general)
    memory.setAnchor(anchored, for: .general)

    let window = try TestWindow(RootView().environment(model), size: outer)
    defer { window.close() }
    try await window.settle()
    var messages = try expectTheChat("folded", in: window, model, after: nil)
    XCTAssertNil(model.sky.lastFrame, "the sky drew on the outer display")
    try window.keep("fold-outer", in: self)

    // Open: the sky on the leading side, at the whole sky, and the chat beside it.
    window.resize(to: landscape)
    try await window.settle()
    try window.keep("fold-open-landscape", in: self)
    XCTAssertNotNil(model.sky.lastFrame, "no sky beside the chat on the inner display")
    messages = try expectTheChat("opened", in: window, model, after: messages)
    XCTAssertLessThan(model.sky.viewport.width, Double(landscape.width) * 0.6)
    XCTAssertEqual(model.sky.viewport.height, Double(landscape.height), accuracy: 1)
    let beside = try await window.until {
      Double(window.frame(of: messages).minX) >= model.sky.viewport.width - 1
    }
    XCTAssertTrue(beside, "the chat isn't beside the sky: \(window.frame(of: messages))")
    XCTAssertEqual(model.sky.scene.camera.mode, .home, "the first unfold isn't at the whole sky")
    let asked = CountedScheduler.asked.withLock { $0 }
    try await Task.sleep(for: .seconds(1))
    XCTAssertGreaterThanOrEqual(
      CountedScheduler.asked.withLock { $0 } - asked, 2, "the sky doesn't ask the scheduler")

    // Moved by hand, then turned: the sky above, the chat below.
    model.sky.zoom(by: 2)
    let scale = model.sky.scene.camera.target.scale
    window.resize(to: portrait)
    try await window.settle()
    try window.keep("fold-open-portrait", in: self)
    messages = try expectTheChat("turned", in: window, model, after: messages)
    XCTAssertEqual(model.sky.viewport.width, Double(portrait.width), accuracy: 1)
    XCTAssertLessThan(model.sky.viewport.height, Double(portrait.height) * 0.6)
    let below = try await window.until {
      Double(window.frame(of: messages).minY) >= model.sky.viewport.height - 1
    }
    XCTAssertTrue(below, "the chat isn't below the sky: \(window.frame(of: messages))")

    // Folded: the chat alone, and the sky neither draws nor asks.
    window.resize(to: outer)
    try await window.settle()
    model.sky.lastFrame = nil
    let folded = CountedScheduler.asked.withLock { $0 }
    try await Task.sleep(for: .seconds(1))
    XCTAssertNil(model.sky.lastFrame, "the sky draws while the phone is folded")
    XCTAssertEqual(
      CountedScheduler.asked.withLock { $0 }, folded, "the sky asks while the phone is folded")
    messages = try expectTheChat("folded again", in: window, model, after: messages)

    // Open again: the sky comes back with the camera it had.
    window.resize(to: landscape)
    try await window.settle()
    XCTAssertNotNil(model.sky.lastFrame, "the sky doesn't come back when the phone opens")
    XCTAssertEqual(model.sky.scene.camera.mode, .manual, "the sky lost its camera")
    XCTAssertEqual(model.sky.scene.camera.target.scale, scale, accuracy: 1e-9)
    _ = try expectTheChat("opened again", in: window, model, after: messages)
  }

  /// Chat still shows #general with its draft and its anchor, and gives its scroll view. Whether
  /// that is the scroll view it had before, or one built again, goes to the test's log.
  @MainActor private func expectTheChat(
    _ step: String, in window: TestWindow, _ model: AppModel, after previous: UIScrollView?,
    line: UInt = #line
  ) throws -> UIScrollView {
    let messages = try XCTUnwrap(
      window.messages(), "\(step): Chat shows no conversation", line: line)
    XCTAssertEqual(model.history.current, .general, "\(step): Chat moved", line: line)
    XCTAssertNotNil(
      window.field(showing: draftText), "\(step): the draft doesn't show", line: line)
    XCTAssertEqual(
      model.memory?.anchor(.general), anchored, "\(step): the scroll moved", line: line)
    if let previous {
      let kept = previous === messages ? "the same" : "built again"
      print("FoldTests: \(step): the conversation's scroll view is \(kept)")
    }
    return messages
  }

  /// Signed in to the fake board, with the scheduler counted and asked every fifth of a second.
  @MainActor private func signedIn() async throws -> AppModel {
    let defaults = try XCTUnwrap(UserDefaults(suiteName: "fold-\(UUID().uuidString)"))
    var environment = FakeBoard.environment(folder: fixturesFolder, defaults: defaults)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CountedScheduler.self, FakeBoard.self]
    environment.session = URLSession(configuration: configuration)
    environment.tokens = MemoryTokens()
    let model = AppModel(environment: environment)
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: "fixture-token")
    try await waitUntilLoaded(model)
    model.sky.schedulerPoll = .milliseconds(200)
    return model
  }
}

/// A window of the test host's scene that a test resizes, with the size classes of the display
/// each size is: a regular width from 600 points, and a regular height.
@MainActor final class TestWindow {
  private let window: UIWindow
  private let host: UIHostingController<AnyView>

  init(_ view: some View, size: CGSize) throws {
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
      "the test host has no window scene")
    window = UIWindow(windowScene: scene)
    host = UIHostingController(rootView: AnyView(view))
    window.rootViewController = host
    resize(to: size)
    window.isHidden = false
  }

  func resize(to size: CGSize) {
    window.frame = CGRect(origin: .zero, size: size)
    host.traitOverrides.horizontalSizeClass = size.width >= 600 ? .regular : .compact
    host.traitOverrides.verticalSizeClass = .regular
  }

  /// Whether `done` holds within five seconds, asked again every tenth of a second.
  func until(_ done: () -> Bool) async throws -> Bool {
    var tries = 0
    while !done(), tries < 50 {
      tries += 1
      host.view.layoutIfNeeded()
      try await Task.sleep(for: .milliseconds(100))
    }
    return done()
  }

  /// Lays the window out and lets its views run what they start.
  func settle() async throws {
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(800))
    host.view.layoutIfNeeded()
  }

  func close() {
    window.isHidden = true
  }

  /// The conversation's scroll view: of the window's scroll views other than text views, the one
  /// with the most to scroll through.
  func messages() -> UIScrollView? {
    views(UIScrollView.self).filter { !($0 is UITextView) }
      .max { $0.contentSize.height < $1.contentSize.height }
  }

  /// The text view or text field showing `text`.
  func field(showing text: String) -> UIView? {
    views(UITextView.self).first { $0.text == text }
      ?? views(UITextField.self).first { $0.text == text }
  }

  /// Where `view` is in the window.
  func frame(of view: UIView) -> CGRect {
    view.convert(view.bounds, to: window)
  }

  /// Keeps a picture of the window with the test's results as `<name>.png`.
  func keep(_ name: String, in test: XCTestCase) throws {
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    try Snapshot.keep(image, named: name, in: test)
  }

  private func views<T: UIView>(_ type: T.Type) -> [T] {
    var found: [T] = []
    var queue: [UIView] = [window]
    while let view = queue.popLast() {
      if let match = view as? T {
        found.append(match)
      }
      queue += view.subviews
    }
    return found
  }
}
