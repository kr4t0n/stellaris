import XCTest

/// A thread's messages as someone reads them: the fake board's samples, which general's newest
/// message links to.
final class MessageUITests: ShellTestCase {
  /// The samples open from the link in general's newest message; an image opens in a viewer, a
  /// long press on code offers to copy it, and a task's id reads as the task's title and opens
  /// its thread in Chat.
  @MainActor func testFollowsAThreadsLinksImagesAndCode() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    let messages = app.scrollViews["messages"].firstMatch
    let samples = messages.links["rendering samples"].firstMatch
    XCTAssertTrue(
      samples.waitForExistence(timeout: 20),
      "general's newest message holds no link to the samples")
    samples.tap()
    // The thread opens at its newest message, far below its title.
    let newest = messages.staticTexts["message-samples-6"].firstMatch
    XCTAssertTrue(newest.waitForExistence(timeout: 20), "the samples don't open in Chat")
    keepDisplays("samples")

    // Newest first, from the foot up: the image, then the code, then the task's id.
    let image = messages.buttons["The export view at 410 pt"].firstMatch
    reveal(app, image)
    image.tap()
    let done = app.buttons["Done"].firstMatch
    XCTAssertTrue(done.waitForExistence(timeout: 20), "the image doesn't open in a viewer")
    keepScreen("image-viewer")
    done.tap()

    let code = messages.scrollViews["code-block"].firstMatch
    reveal(app, code)
    code.press(forDuration: 1.5)
    let copy = app.buttons["Copy"].firstMatch
    XCTAssertTrue(copy.waitForExistence(timeout: 20), "a long press on code offers no Copy")
    keepScreen("code-copy")
    copy.tap()

    let task = messages.links["Add the export view"].firstMatch
    reveal(app, task)
    task.tap()
    expectConversation(app, "Add the export view")
  }

  /// Drags the conversation down, to older messages, until `element` is on screen.
  @MainActor private func reveal(_ app: XCUIApplication, _ element: XCUIElement) {
    for _ in 0..<12 where !(element.exists && element.isHittable) {
      dragDown(app)
    }
    XCTAssertTrue(element.exists && element.isHittable, "\(element) isn't on screen")
  }

  /// Keeps a picture of each of the simulator's displays.
  @MainActor private func keepDisplays(_ name: String) {
    for (index, screen) in XCUIScreen.screens.enumerated() {
      let attachment = XCTAttachment(screenshot: screen.screenshot())
      attachment.name = "display-\(index)-\(name).png"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
}
