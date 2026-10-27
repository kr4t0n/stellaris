import XCTest

/// The sky alone in the app's window, as a debug build launched with `-StellarisSky` shows it, over
/// the fake board: what a tap opens, what a drag and a pinch do to the camera, what VoiceOver
/// lists, and what the recorded turn stream raises. Queries stay inside the sky, which keeps
/// XCTest's walk of the app small.
final class SkyUITests: ShellTestCase {
  /// The captured tasks: one at the user's stage, one held by eng-1.
  private let atTheUsersStage = "00000000000000000000000010"
  private let held = "00000000000000000000000012"

  /// Signs in to the sky and waits for it to settle.
  @MainActor private func openSky() -> (XCUIApplication, XCUIElement) {
    let app = launch(arguments: ["-StellarisSky"])
    signIn(app)
    let sky = app.otherElements["sky"].firstMatch
    XCTAssertTrue(sky.buttons["sky-star-eng-1"].waitForExistence(timeout: 20), "no star for eng-1")
    // Stars rise to their seats and the camera eases home in about two seconds.
    let settled = expectation(description: "the sky settles")
    settled.isInverted = true
    wait(for: [settled], timeout: 3)
    return (app, sky)
  }

  @MainActor private func expectValue(_ element: XCUIElement, _ format: String, _ value: String) {
    let matched = expectation(
      for: NSPredicate(format: "value \(format) %@", value), evaluatedWith: element)
    wait(for: [matched], timeout: 20)
  }

  /// A tap opens the card of the star or the task's mark under it, Close shuts it, and a drag that
  /// starts on a star moves the sky without opening one.
  @MainActor func testATapOpensACard() {
    let (_, sky) = openSky()
    let card = sky.otherElements["sky-card"].firstMatch
    let title = card.staticTexts["sky-card-title"].firstMatch

    sky.buttons["sky-star-eng-1"].tap()
    XCTAssertTrue(title.waitForExistence(timeout: 20), "a tap on eng-1 opens no card")
    XCTAssertEqual(title.label, "eng-1")
    keepScreen("sky-card-citizen")

    sky.buttons["sky-task-\(held)"].tap()
    let task = NSPredicate(format: "label == %@", "Fix the empty state")
    wait(for: [expectation(for: task, evaluatedWith: title)], timeout: 20)
    keepScreen("sky-card-task")

    card.buttons["sky-card-close"].tap()
    XCTAssertTrue(card.waitForNonExistence(timeout: 20), "Close leaves the card open")

    let star = sky.buttons["sky-star-rev-1"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    star.press(forDuration: 0.1, thenDragTo: star.withOffset(CGVector(dx: -120, dy: -120)))
    expectValue(sky.buttons["sky-camera"], "CONTAINS", "%")
    XCTAssertFalse(card.exists, "a drag from a star opened its card")
  }

  /// A pinch and a drag each move the camera, as its VoiceOver element's value says, and a pinch out
  /// past the whole sky goes back to it; no Fit button sits over the sky. The element's own Fit is
  /// VoiceOver's to activate, which XCTest can't do, so `SkyAccessibilityTests` does it in the app.
  @MainActor func testPinchAndDragMoveTheCamera() throws {
    let (_, sky) = openSky()
    XCTAssertFalse(sky.buttons["sky-fit"].exists, "the sky still has a Fit button")
    let camera = sky.buttons["sky-camera"]
    XCTAssertEqual(camera.value as? String, "Whole sky")

    sky.pinch(withScale: 2, velocity: 1)
    expectValue(camera, "CONTAINS", "%")
    let pinched = try XCTUnwrap(camera.value as? String)

    let start = sky.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.7))
    start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 120, dy: -80)))
    expectValue(camera, "!=", pinched)
    keepScreen("sky-moved")

    sky.pinch(withScale: 0.2, velocity: -1)
    expectValue(camera, "==", "Whole sky")
    keepScreen("sky-pinched-home")
  }

  /// VoiceOver finds the camera, and every sphere, star, and task's mark, in words.
  @MainActor func testListsTheSkyForVoiceOver() {
    let (_, sky) = openSky()
    let listed = Set(
      sky.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'sky-'"))
        .allElementsBoundByIndex.map(\.identifier))
    XCTAssertEqual(
      listed,
      [
        "sky-sphere-society", "sky-sphere-demo", "sky-task-\(atTheUsersStage)", "sky-task-\(held)",
        "sky-star-concierge-1", "sky-star-eng-1", "sky-star-rev-1", "sky-camera",
      ])
    XCTAssertEqual(sky.buttons["sky-camera"].label, "Fit the whole sky")
    XCTAssertEqual(sky.buttons["sky-sphere-demo"].label, "Demo")
    XCTAssertEqual(
      sky.buttons["sky-task-\(atTheUsersStage)"].label,
      "Task Add the export view at Demo, stage Approve the design, waiting for a holder, for user")
    XCTAssertEqual(
      sky.buttons["sky-task-\(held)"].label,
      "Task Fix the empty state at Demo, stage work, being worked, held by eng-1")
    XCTAssertEqual(sky.buttons["sky-star-rev-1"].label, "rev-1")
  }

  /// The recorded turn stream, stamped now: the post's first line rises from eng-1's star, which
  /// VoiceOver reads with the star. The pictures show both displays: the inner one is black, since
  /// the simulator keeps the phone closed.
  @MainActor func testTheTurnStreamRaisesAPostsLine() {
    let (_, sky) = openSky()
    expectValue(sky.buttons["sky-star-eng-1"], "CONTAINS", "posted The export view is in")
    keepScreen("sky")
    for (index, screen) in XCUIScreen.screens.enumerated() {
      let attachment = XCTAttachment(screenshot: screen.screenshot())
      attachment.name = "display-\(index)-sky.png"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
}
