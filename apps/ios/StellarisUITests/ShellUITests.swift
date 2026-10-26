import XCTest

/// The fixtures the fake board answers from, beside this folder.
private let fixtures = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()  // StellarisUITests
  .deletingLastPathComponent()  // ios
  .appendingPathComponent("fixtures/api").path

/// The app as someone uses it on the simulator, signed in to the fake board.
class ShellTestCase: XCTestCase {
  /// Launches the app against the fake board, afresh unless `reset` is false.
  @MainActor func launch(reset: Bool = true) -> XCUIApplication {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    let app = XCUIApplication()
    app.launchEnvironment["STELLARIS_FAKE_BOARD"] = fixtures
    if reset {
      app.launchArguments.append("-StellarisReset")
    }
    app.launch()
    return app
  }

  @MainActor func signIn(_ app: XCUIApplication, token: String = "fixture-token") {
    let address = app.textFields["address"]
    XCTAssertTrue(address.waitForExistence(timeout: 20))
    address.tap()
    address.typeText("board.example.com")
    // The keyboard's return key is also called "continue".
    app.buttons["take-address"].tap()
    let field = app.secureTextFields["token"]
    XCTAssertTrue(field.waitForExistence(timeout: 20))
    field.tap()
    field.typeText(token)
    app.buttons["sign-in-token"].tap()
  }

  /// Waits for Chat to show the society's general channel, which opens at its newest message. Its
  /// title, the first line of its content, is sixty messages up, where the view builds nothing.
  @MainActor func expectGeneral(_ app: XCUIApplication) {
    XCTAssertTrue(message(app, 60).waitForExistence(timeout: 20), "Chat doesn't show #general")
    XCTAssertTrue(message(app, 60).isHittable, "#general doesn't open at its newest message")
  }

  /// Waits for Chat to show the conversation called `name`, short enough that its title shows.
  @MainActor func expectConversation(_ app: XCUIApplication, _ name: String) {
    let title = app.staticTexts["conversation-title"].firstMatch
    let shown = expectation(for: NSPredicate(format: "label == %@", name), evaluatedWith: title)
    wait(for: [shown], timeout: 20)
  }

  @MainActor func tab(_ app: XCUIApplication, _ name: String) {
    let button = app.buttons[name].firstMatch
    XCTAssertTrue(button.waitForExistence(timeout: 20))
    button.tap()
  }

  @MainActor func pick(_ app: XCUIApplication, _ identifier: String) {
    let row = app.buttons[identifier].firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 20))
    row.tap()
  }

  @MainActor func message(_ app: XCUIApplication, _ number: Int) -> XCUIElement {
    app.staticTexts[String(format: "message-general-%02d", number)].firstMatch
  }

  /// The number of the lowest message of #general on screen, if one is.
  @MainActor func lowestShown(_ app: XCUIApplication) -> Int? {
    let shown = app.staticTexts
      .matching(NSPredicate(format: "identifier BEGINSWITH 'message-general-'"))
      .allElementsBoundByIndex.filter { $0.isHittable }
      .compactMap { Int($0.identifier.dropFirst("message-general-".count)) }
    return shown.max()
  }

  @MainActor func draft(_ app: XCUIApplication) -> XCUIElement {
    app.textFields["draft"].firstMatch
  }

  /// Drags the conversation down by half its height `times` times, to older messages; the first
  /// drag also puts the keyboard away, which covers the side bar's tabs on the outer display.
  @MainActor func dragDown(_ app: XCUIApplication, times: Int = 1) {
    // By its name: with the keyboard up, the first scroll view is its row of suggestions.
    let messages = app.scrollViews["messages"].firstMatch
    for _ in 0..<times {
      let start = messages.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.25))
      let end = messages.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.75))
      start.press(forDuration: 0.1, thenDragTo: end)
    }
  }

  /// Sends the app to the background, where iOS suspends it, by bringing Settings to the front, as
  /// switching to another app does: on the iPhone Duo simulator, pressing Home leaves it in front.
  @MainActor func toBackground(_ app: XCUIApplication) {
    let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
    settings.activate()
    XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 20))
    let away = app.wait(for: .runningBackgroundSuspended, timeout: 20)
    XCTAssertTrue(away || app.state == .runningBackground, "the app is still in front")
  }

  /// Keeps a picture of the screen with the test's results.
  @MainActor func keepScreen(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = "\(name).png"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}

final class ShellUITests: ShellTestCase {
  /// The draft and the scroll position of the open conversation survive a trip to Board and back.
  /// Rotation isn't checked here: setting the orientation leaves the iPhone Duo simulator's outer
  /// display as it is.
  @MainActor func testKeepsTheDraftAndScrollPositionThroughBoardAndBack() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    let newest = message(app, 60)
    XCTAssertTrue(newest.isHittable)

    draft(app).tap()
    draft(app).typeText("Half a thought")
    dragDown(app, times: 3)
    keepScreen("scrolled-up")
    XCTAssertFalse(newest.exists && newest.isHittable)
    guard let anchored = lowestShown(app) else {
      return XCTFail("no message of #general shows after scrolling")
    }

    tab(app, "Board")
    XCTAssertTrue(app.buttons["channel-governance"].waitForExistence(timeout: 20))
    tab(app, "Chat")
    XCTAssertTrue(message(app, anchored).waitForExistence(timeout: 20))
    XCTAssertEqual(lowestShown(app), anchored)
    XCTAssertFalse(newest.exists && newest.isHittable)
    XCTAssertEqual(draft(app).value as? String, "Half a thought")
  }

  /// Picking in Board or Needs you opens the conversation in Chat, and Back retraces the steps.
  @MainActor func testBackGoesToWhereChatCameFrom() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    XCTAssertFalse(app.buttons["back"].exists)

    tab(app, "Board")
    pick(app, "task-00000000000000000000000010")
    expectConversation(app, "Add the export view")
    tab(app, "Needs you")
    pick(app, "proposal-00000000000000000000000004")
    expectConversation(app, "Member proposal")
    tab(app, "Board")
    pick(app, "channel-governance")
    expectConversation(app, "#governance")
    XCTAssertTrue(app.staticTexts["No messages"].waitForExistence(timeout: 20))

    pick(app, "back")
    expectConversation(app, "Member proposal")
    pick(app, "back")
    expectConversation(app, "Add the export view")
    pick(app, "back")
    expectGeneral(app)
    XCTAssertFalse(app.buttons["back"].exists)
  }

  /// Back from the background shows the conversation that was open; a fresh start shows general,
  /// and each conversation's draft is kept on disk.
  @MainActor func testOpensTheLastConversationFromTheBackgroundAndGeneralOnAFreshStart() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Board")
    pick(app, "channel-governance")
    expectConversation(app, "#governance")
    draft(app).tap()
    draft(app).typeText("Kept on disk")
    dragDown(app)

    toBackground(app)
    app.activate()
    expectConversation(app, "#governance")
    XCTAssertEqual(draft(app).value as? String, "Kept on disk")

    // Ended in the background, as iOS ends an app or someone swipes it away.
    toBackground(app)
    app.terminate()
    let again = launch(reset: false)
    expectGeneral(again)
    tab(again, "Board")
    pick(again, "channel-governance")
    expectConversation(again, "#governance")
    XCTAssertEqual(draft(again).value as? String, "Kept on disk")
  }

  @MainActor func testStaysAtSignInWithATokenTheBoardRefuses() {
    let app = launch()
    signIn(app, token: "refused")
    let problem = app.staticTexts["sign-in-problem"]
    XCTAssertTrue(problem.waitForExistence(timeout: 20))
    XCTAssertEqual(problem.label, "The board doesn't take this token.")
  }

  /// A 401 once signed in, as when the sign-in is revoked, returns the app to sign-in.
  @MainActor func testReturnsToSignInWhenTheBoardStopsTakingTheToken() {
    let app = launch()
    signIn(app, token: "revoked")
    let notice = app.staticTexts["sign-in-notice"]
    XCTAssertTrue(notice.waitForExistence(timeout: 20))
    XCTAssertEqual(notice.label, "The board ended this sign-in.")
    XCTAssertTrue(app.textFields["address"].exists)
  }

  @MainActor func testSignsOutFromSettings() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Board")
    pick(app, "settings")
    XCTAssertTrue(app.staticTexts["settings-board"].waitForExistence(timeout: 20))
    XCTAssertEqual(app.staticTexts["settings-board"].label, "https://board.example.com")
    pick(app, "sign-out")
    XCTAssertTrue(app.textFields["address"].waitForExistence(timeout: 20))
    XCTAssertFalse(app.staticTexts["sign-in-notice"].exists)
  }
}

/// Pictures of each screen on the simulator, and what the simulator says of its displays, for
/// review; these fail only when a screen can't be reached.
final class ScreenUITests: ShellTestCase {
  @MainActor func testScreens() {
    let app = launch()
    let screens = XCUIScreen.screens
    print("screens: \(screens.count); window: \(app.windows.firstMatch.frame)")
    for (index, screen) in screens.enumerated() {
      let attachment = XCTAttachment(screenshot: screen.screenshot())
      attachment.name = "display-\(index)-sign-in.png"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
    keepScreen("sign-in")
    signIn(app)
    // Chat is the tab shown: tapping it again would scroll the conversation to its top, as iOS
    // does for the tab in front. Portrait alone, since setting the orientation leaves the
    // simulator's outer display as it is.
    expectGeneral(app)
    print("window: \(app.windows.firstMatch.frame)")
    keepScreen("chat")
    tab(app, "Board")
    XCTAssertTrue(app.buttons["channel-governance"].waitForExistence(timeout: 20))
    keepScreen("board")
    tab(app, "Needs you")
    XCTAssertTrue(app.buttons["stage-00000000000000000000000010"].waitForExistence(timeout: 20))
    keepScreen("needs-you")
    tab(app, "Board")
    pick(app, "settings")
    XCTAssertTrue(app.staticTexts["settings-board"].waitForExistence(timeout: 20))
    keepScreen("settings")
    app.buttons["Done"].firstMatch.tap()
    pick(app, "task-00000000000000000000000010")
    expectConversation(app, "Add the export view")
    keepScreen("thread")
    pick(app, "back")
    expectGeneral(app)
  }
}
