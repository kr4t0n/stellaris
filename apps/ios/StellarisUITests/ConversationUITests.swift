import XCTest

/// Talking in a conversation: posting from the composer, mentioning a citizen, opening a thread,
/// and following a link to a message.
final class ConversationUITests: ShellTestCase {
  /// Typing `@` offers the citizens to mention, a pick completes the name, and Send posts the draft
  /// to the foot of the conversation and empties the box.
  @MainActor func testPostsFromTheComposerWithAMention() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    let box = draft(app)
    box.tap()
    box.typeText("Ship it, @e")
    let candidate = app.buttons["mention-eng-1"].firstMatch
    XCTAssertTrue(candidate.waitForExistence(timeout: 20), "typing @e offers no eng-1 to mention")
    XCTAssertFalse(
      app.buttons["mention-rev-1"].exists, "a citizen whose name doesn't start @e is offered")
    keepScreen("mention")
    candidate.tap()
    XCTAssertEqual(box.value as? String, "Ship it, @eng-1 ")
    XCTAssertFalse(candidate.exists, "the mention is still offered once completed")
    box.typeText("now")

    app.buttons["send"].firstMatch.tap()
    let posted = app.scrollViews["messages"].staticTexts
      .matching(NSPredicate(format: "label == %@", "Ship it, @eng-1 now")).firstMatch
    XCTAssertTrue(posted.waitForExistence(timeout: 20), "the post doesn't show in #general")
    XCTAssertTrue(posted.isHittable, "the post isn't at the foot of the conversation")
    XCTAssertLessThanOrEqual(posted.frame.maxY, box.frame.minY, "the post is under the draft")
    XCTAssertNotEqual(box.value as? String, "Ship it, @eng-1 now", "the draft stays after Send")
    keepScreen("posted")
  }

  /// New thread in the bar opens a sheet for its title and first message; opening it shows the
  /// thread in Chat, and Back shows it in its channel's stream.
  @MainActor func testOpensAThreadFromItsChannel() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    pick(app, "new-thread")
    let title = app.textFields["thread-title"].firstMatch
    XCTAssertTrue(title.waitForExistence(timeout: 20), "New thread opens no sheet")
    title.tap()
    title.typeText("Release checklist")
    let first = app.textFields["thread-first-message"].firstMatch
    first.tap()
    first.typeText("Docs first.")
    keepScreen("new-thread")
    pick(app, "open-thread")

    expectConversation(app, "Release checklist")
    let said = app.scrollViews["messages"].staticTexts
      .matching(NSPredicate(format: "label == %@", "Docs first.")).firstMatch
    XCTAssertTrue(said.waitForExistence(timeout: 20), "the thread doesn't hold its first message")
    XCTAssertFalse(title.exists, "the sheet stays once the thread is open")

    pick(app, "back")
    // At the foot, where it was opened, below #general's newest message.
    let row = app.scrollViews["messages"].buttons
      .matching(
        NSPredicate(
          format: "identifier BEGINSWITH 'thread-' AND label CONTAINS %@", "Release checklist")
      ).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 20), "#general doesn't show the thread opened")
    XCTAssertTrue(row.isHittable, "the thread's row isn't at #general's foot")
    XCTAssertGreaterThan(row.frame.minY, message(app, 60).frame.minY)
    keepScreen("thread-in-channel")
  }

  /// A link to a message opens its conversation at that message, marked, not at the foot.
  @MainActor func testOpensALinkedMessageWhereItIs() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    let messages = app.scrollViews["messages"].firstMatch
    messages.links["rendering samples"].firstMatch.tap()
    let newest = messages.staticTexts["message-samples-6"].firstMatch
    XCTAssertTrue(newest.waitForExistence(timeout: 20), "the samples don't open in Chat")

    // The newest sample, at the foot, links to a note far up #general.
    let link = messages.links["note 30"].firstMatch
    XCTAssertTrue(link.waitForExistence(timeout: 20), "the newest sample holds no link to note 30")
    link.tap()
    let target = message(app, 30)
    XCTAssertTrue(target.waitForExistence(timeout: 20), "the link doesn't open #general at note 30")
    XCTAssertTrue(target.isHittable, "note 30 isn't on screen")
    XCTAssertTrue(target.isSelected, "note 30 isn't marked as the message the link named")
    let foot = message(app, 60)
    XCTAssertFalse(foot.exists && foot.isHittable, "#general opened at its foot")
    keepScreen("linked-message")
  }
}
