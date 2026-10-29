import XCTest

/// The fixtures the fake board answers from, beside this folder.
private let fixtures = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()  // StellarisUITests
  .deletingLastPathComponent()  // ios
  .appendingPathComponent("fixtures/api").path

/// What a message of #general is named by in the fake board, before its number: its id is
/// shaped as the board's are, so a link can name it.
let generalMessage = "message-000000000000000000000GEN"

/// The app as someone uses it on the simulator, signed in to the fake board.
class ShellTestCase: XCTestCase {
  /// Launches the app against the fake board, afresh unless `reset` is false, with `arguments`.
  @MainActor func launch(reset: Bool = true, arguments: [String] = []) -> XCUIApplication {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    let app = XCUIApplication()
    app.launchEnvironment["STELLARIS_FAKE_BOARD"] = fixtures
    if reset {
      app.launchArguments.append("-StellarisReset")
    }
    app.launchArguments += arguments
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
    let newest = message(app, 60)
    XCTAssertTrue(newest.waitForExistence(timeout: 20), "Chat doesn't show #general")
    XCTAssertTrue(newest.isHittable, "#general doesn't open at its newest message")
    XCTAssertLessThanOrEqual(
      newest.frame.maxY, draft(app).frame.minY, "#general's newest message is under the draft")
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

  /// Closes a sheet by dragging it down to the window's foot from `start`, a point relative to its
  /// bar: by default on the bar, right of the status bar's frame at the top-leading corner, which
  /// takes touches there.
  @MainActor func dragAway(
    _ app: XCUIApplication, _ bar: XCUIElement, from start: CGVector = CGVector(dx: 0.8, dy: 0.5)
  ) {
    XCTAssertTrue(bar.waitForExistence(timeout: 20))
    bar.coordinate(withNormalizedOffset: start)
      .press(
        forDuration: 0.1,
        thenDragTo: app.windows.firstMatch.coordinate(
          withNormalizedOffset: CGVector(dx: start.dx, dy: 0.98)))
  }

  /// Checks that a sheet's `button` stands in the side column at the window's trailing edge, where
  /// the outer display puts a bar's symbols, and not in a bar across the top, which ends about 88
  /// points short of the edge, where that column begins.
  @MainActor func expectInTheSideColumn(_ app: XCUIApplication, _ button: XCUIElement) {
    XCTAssertTrue(button.waitForExistence(timeout: 20))
    let edge = app.windows.firstMatch.frame.maxX
    XCTAssertGreaterThan(
      button.frame.midX, edge - 70,
      "\(button.label) stands \(Int(edge - button.frame.maxX)) pt short of the window's edge")
  }

  /// A message of #general, looked for in the conversation alone, which keeps XCTest's walk of
  /// the app small.
  @MainActor func message(_ app: XCUIApplication, _ number: Int) -> XCUIElement {
    app.scrollViews["messages"].staticTexts[generalMessage + String(format: "%02d", number)]
      .firstMatch
  }

  /// The number of the lowest message of #general on screen, if one is.
  @MainActor func lowestShown(_ app: XCUIApplication) -> Int? {
    let shown = app.scrollViews["messages"].staticTexts
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", generalMessage))
      .allElementsBoundByIndex.filter { $0.isHittable }
      .compactMap { Int($0.identifier.dropFirst(generalMessage.count)) }
    return shown.max()
  }

  @MainActor func draft(_ app: XCUIApplication) -> XCUIElement {
    app.textFields["draft"].firstMatch
  }

  /// Drags the conversation down by half its height `times` times, to older messages; the first
  /// drag also puts the keyboard away, which covers the side bar's tabs on the outer display. It
  /// starts below a bar across the top of the conversation, where the inner display's horizontal
  /// bars put New thread.
  @MainActor func dragDown(_ app: XCUIApplication, times: Int = 1) {
    // By its name: with the keyboard up, the first scroll view is its row of suggestions.
    let messages = app.scrollViews["messages"].firstMatch
    for _ in 0..<times {
      let start = messages.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.4))
      let end = messages.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.9))
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
    expectConversation(app, "Member eng-2 as engineer on claude for demo")
    tab(app, "Board")
    pick(app, "channel-governance")
    expectConversation(app, "#governance")
    // No messages, but the threads opened on it, a proposal's among them.
    XCTAssertTrue(
      app.buttons["thread-00000000000000000000000004"].waitForExistence(timeout: 20),
      "#governance doesn't show the proposals' threads")

    pick(app, "back")
    expectConversation(app, "Member eng-2 as engineer on claude for demo")
    pick(app, "back")
    expectConversation(app, "Add the export view")
    pick(app, "back")
    expectGeneral(app)
    XCTAssertFalse(app.buttons["back"].exists)
  }

  /// Back from the background, Chat shows the conversation that was open, with its draft.
  @MainActor func testShowsTheLastConversationBackFromTheBackground() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Board")
    pick(app, "channel-governance")
    expectConversation(app, "#governance")
    draft(app).tap()
    draft(app).typeText("Half a thought")
    dragDown(app)

    toBackground(app)
    app.activate()
    expectConversation(app, "#governance")
    XCTAssertEqual(draft(app).value as? String, "Half a thought")
  }

  /// A fresh start opens the society's general channel, whatever was open, and each
  /// conversation's draft is kept on disk. The app ends in front here: it keeps nothing about
  /// where it was, so ending it in the background, which the simulator makes hard to do twice
  /// in a test, starts it the same way.
  @MainActor func testOpensGeneralOnAFreshStartWithTheDraftsKept() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Board")
    pick(app, "channel-governance")
    expectConversation(app, "#governance")
    draft(app).tap()
    draft(app).typeText("Kept on disk")
    dragDown(app)

    app.terminate()
    let again = launch(reset: false)
    expectGeneral(again)
    tab(again, "Board")
    pick(again, "channel-governance")
    expectConversation(again, "#governance")
    XCTAssertEqual(draft(again).value as? String, "Kept on disk")
  }

  /// An address where nothing answers keeps sign-in at the address, saying so.
  @MainActor func testStaysAtTheAddressWhenNoBoardAnswers() {
    let app = launch()
    let address = app.textFields["address"]
    XCTAssertTrue(address.waitForExistence(timeout: 20))
    address.tap()
    address.typeText("nowhere.invalid")
    app.buttons["take-address"].tap()
    let problem = app.staticTexts["sign-in-problem"]
    XCTAssertTrue(problem.waitForExistence(timeout: 20))
    XCTAssertEqual(problem.label, "Can't reach the board.")
    XCTAssertTrue(address.exists)
    XCTAssertFalse(app.secureTextFields["token"].exists)
  }

  /// A refresh that fails once Board has loaded leaves its rows as they were.
  @MainActor func testKeepsBoardsRowsWhenARefreshFails() {
    let app = launch()
    signIn(app, token: "fading")
    expectGeneral(app)
    tab(app, "Board")
    let general = app.buttons["channel-general"]
    XCTAssertTrue(general.waitForExistence(timeout: 20))
    // Pulled down, Board loads again, and the board's channels don't come.
    let start = general.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 320)))
    XCTAssertFalse(
      app.buttons["Retry"].waitForExistence(timeout: 10), "the failure covers Board's rows")
    keepScreen("board-refresh-failed")
    XCTAssertTrue(general.isHittable)
    XCTAssertTrue(app.buttons["channel-governance"].isHittable)
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
    XCTAssertFalse(app.buttons["Done"].exists, "Settings has a Done")
    dragAway(app, app.navigationBars["Settings"].firstMatch)
    XCTAssertTrue(
      app.staticTexts["settings-board"].waitForNonExistence(timeout: 20),
      "a drag down leaves Settings open")
    pick(app, "task-00000000000000000000000010")
    expectConversation(app, "Add the export view")
    keepScreen("thread")
    pick(app, "back")
    expectGeneral(app)
  }
}
