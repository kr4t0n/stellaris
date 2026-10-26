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

  /// Waits for Chat to show the conversation called `name`.
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
    app.descendants(matching: .any)[String(format: "message-general-%02d", number)].firstMatch
  }

  @MainActor func draft(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)["draft"].firstMatch
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
  /// The draft and the scroll position of the open conversation survive a trip to Board and back,
  /// and a rotation.
  @MainActor func testKeepsTheDraftAndScrollPositionThroughBoardAndARotation() {
    let app = launch()
    signIn(app)
    expectConversation(app, "#general")
    let newest = message(app, 60)
    XCTAssertTrue(newest.waitForExistence(timeout: 20))
    XCTAssertTrue(newest.isHittable)

    draft(app).tap()
    draft(app).typeText("Half a thought")
    let messages = app.scrollViews.firstMatch
    for _ in 0..<3 {
      messages.swipeDown()
    }
    XCTAssertFalse(newest.exists && newest.isHittable)
    guard
      let anchored = (1...59).reversed().first(where: {
        message(app, $0).exists && message(app, $0).isHittable
      })
    else {
      return XCTFail("no message shows after scrolling")
    }

    tab(app, "Board")
    XCTAssertTrue(app.buttons["channel-governance"].waitForExistence(timeout: 20))
    tab(app, "Chat")
    expectConversation(app, "#general")
    XCTAssertEqual(draft(app).value as? String, "Half a thought")
    XCTAssertTrue(message(app, anchored).isHittable)
    XCTAssertFalse(newest.exists && newest.isHittable)

    XCUIDevice.shared.orientation = .landscapeLeft
    XCTAssertTrue(message(app, anchored).waitForExistence(timeout: 20))
    XCTAssertTrue(message(app, anchored).isHittable)
    XCTAssertEqual(draft(app).value as? String, "Half a thought")
    XCUIDevice.shared.orientation = .portrait
    XCTAssertTrue(message(app, anchored).isHittable)
  }

  /// Picking in Board or Needs you opens the conversation in Chat, and Back retraces the steps.
  @MainActor func testBackGoesToWhereChatCameFrom() {
    let app = launch()
    signIn(app)
    expectConversation(app, "#general")
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
    expectConversation(app, "#general")
    XCTAssertFalse(app.buttons["back"].exists)
  }

  /// Back from the background shows the conversation that was open; a fresh start shows general,
  /// with the draft kept on disk.
  @MainActor func testOpensTheLastConversationFromTheBackgroundAndGeneralOnAFreshStart() {
    let app = launch()
    signIn(app)
    expectConversation(app, "#general")
    draft(app).tap()
    draft(app).typeText("Kept on disk")
    tab(app, "Board")
    pick(app, "channel-governance")
    expectConversation(app, "#governance")

    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 20))
    app.activate()
    expectConversation(app, "#governance")

    // Ended in the background, as iOS ends an app or someone swipes it away.
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 20))
    app.terminate()
    let again = launch(reset: false)
    expectConversation(again, "#general")
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
    expectConversation(app, "#general")
    tab(app, "Board")
    pick(app, "settings")
    XCTAssertTrue(app.staticTexts["settings-board"].waitForExistence(timeout: 20))
    XCTAssertEqual(app.staticTexts["settings-board"].label, "https://board.example.com")
    pick(app, "sign-out")
    XCTAssertTrue(app.textFields["address"].waitForExistence(timeout: 20))
    XCTAssertFalse(app.staticTexts["sign-in-notice"].exists)
  }
}

/// Pictures of each screen on the simulator in both orientations, and what the simulator says of
/// its displays, for review; these fail only when a screen can't be reached.
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
    keepScreen("portrait-sign-in")
    signIn(app)
    expectConversation(app, "#general")
    for name in ["portrait", "landscape"] {
      XCUIDevice.shared.orientation = name == "portrait" ? .portrait : .landscapeLeft
      tab(app, "Chat")
      expectConversation(app, "#general")
      print("\(name) window: \(app.windows.firstMatch.frame)")
      keepScreen("\(name)-chat")
      tab(app, "Board")
      XCTAssertTrue(app.buttons["channel-governance"].waitForExistence(timeout: 20))
      keepScreen("\(name)-board")
      tab(app, "Needs you")
      XCTAssertTrue(app.buttons["stage-00000000000000000000000010"].waitForExistence(timeout: 20))
      keepScreen("\(name)-needs-you")
      tab(app, "Board")
      pick(app, "settings")
      XCTAssertTrue(app.staticTexts["settings-board"].waitForExistence(timeout: 20))
      keepScreen("\(name)-settings")
      app.buttons["Done"].firstMatch.tap()
      pick(app, "task-00000000000000000000000010")
      expectConversation(app, "Add the export view")
      keepScreen("\(name)-thread")
    }
    XCUIDevice.shared.orientation = .portrait
  }
}
