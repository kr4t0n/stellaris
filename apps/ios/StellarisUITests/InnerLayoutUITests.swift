import XCTest

/// The inner display's split, which a debug build launched with `-StellarisInnerLayout` lays out
/// in the outer display's window, since the simulator in CI keeps the inner display closed: a
/// window taller than wide puts the sky above the chat, as the inner display in portrait does.
final class InnerLayoutUITests: ShellTestCase {
  /// The sky sits above the chat, and a tap opens a card inside the sky's part. While the keyboard
  /// is up the chat grows over the sky, whose stars take no touch, and once the keyboard goes the
  /// chat drops back below it with the draft kept. XCUITest lists the covered sky's elements all
  /// the same, so whether VoiceOver skips them is checked on the device.
  @MainActor func testTheChatGrowsOverTheSkyWhileTheKeyboardIsUp() {
    let app = launch(arguments: ["-StellarisInnerLayout"])
    signIn(app)
    expectGeneral(app)
    let sky = app.otherElements["sky"].firstMatch
    let messages = app.scrollViews["messages"].firstMatch
    XCTAssertTrue(sky.waitForExistence(timeout: 20), "no sky beside the chat")
    let skyFrame = sky.frame
    XCTAssertGreaterThanOrEqual(
      messages.frame.minY, skyFrame.maxY - 1, "the chat isn't below the sky")

    let star = sky.buttons["sky-star-eng-1"]
    XCTAssertTrue(star.waitForExistence(timeout: 20), "no star for eng-1")
    // Stars rise to their seats and the camera eases home in about two seconds.
    let settled = expectation(description: "the sky settles")
    settled.isInverted = true
    wait(for: [settled], timeout: 3)
    star.tap()
    let card = sky.otherElements["sky-card"].firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 20), "a tap on eng-1 opens no card")
    XCTAssertTrue(skyFrame.insetBy(dx: -1, dy: -1).contains(card.frame), "the card leaves the sky")
    keepScreen("inner-stacked-card")
    card.buttons["sky-card-close"].tap()
    XCTAssertTrue(card.waitForNonExistence(timeout: 20), "Close leaves the card open")

    draft(app).tap()
    draft(app).typeText(draftText)
    // Over the sky's whole width: a split turned side by side would leave the sky in view.
    waitUntil("the chat doesn't grow over the sky") {
      messages.frame.minY < skyFrame.midY && messages.frame.width >= skyFrame.width - 1
    }
    keepScreen("inner-stacked-typing")
    waitUntil("the covered sky's stars take a touch") { !star.isHittable }

    // A drag of the conversation puts the keyboard away.
    dragDown(app)
    waitUntil("the chat doesn't drop back below the sky") {
      messages.frame.minY >= skyFrame.maxY - 1
    }
    waitUntil("the sky's stars take no touch once the keyboard goes") { star.isHittable }
    XCTAssertEqual(draft(app).value as? String, draftText)
    keepScreen("inner-stacked-after-typing")
  }

  private let draftText = "Half a thought"

  /// Waits up to twenty seconds for `done`, asking again every quarter of a second.
  @MainActor private func waitUntil(_ failure: String, _ done: () -> Bool) {
    let deadline = Date.now.addingTimeInterval(20)
    while !done() {
      guard Date.now < deadline else {
        return XCTFail(failure)
      }
      RunLoop.current.run(until: .now.addingTimeInterval(0.25))
    }
  }
}
