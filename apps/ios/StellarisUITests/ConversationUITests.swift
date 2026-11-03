import UIKit
import XCTest

/// Talking in a conversation: posting from the composer, mentioning a citizen, putting an image in
/// a post, opening a thread, and following a link to a message.
final class ConversationUITests: ShellTestCase {
  /// Paste, from the menu a long press on the draft opens, puts the image copied into the draft at
  /// the caret: a line holds its place while it uploads, with Send off, then the board's markdown
  /// for it, the caret after it, and Send shows it in the post. The fake board answers the token
  /// `slow-uploads` late, so the upload can be seen under way.
  @MainActor func testPastesAnImageIntoAPost() {
    let app = launch()
    signIn(app, token: "slow-uploads")
    expectGeneral(app)
    let box = draft(app)
    box.tap()
    box.typeText("The plot: ")
    let size = CGSize(width: 320, height: 200)
    UIPasteboard.general.image = UIGraphicsImageRenderer(size: size).image { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(origin: .zero, size: size))
    }
    box.press(forDuration: 1.2)
    let paste = app.menuItems["Paste"].firstMatch
    XCTAssertTrue(paste.waitForExistence(timeout: 10), "the draft's menu has no Paste for an image")
    keepScreen("image-menu")
    paste.tap()

    XCTAssertTrue(
      draft(box, matches: #"The plot: !\[Uploading image…\]\(\)"#),
      "the draft holds no place for the image while it uploads")
    XCTAssertFalse(app.buttons["send"].firstMatch.isEnabled, "Send is on while an image uploads")
    keepScreen("image-uploading")
    XCTAssertTrue(
      draft(box, matches: #"The plot: !\[image\.(png|jpeg)\]\(image:[0-9A-Z]{26}\)"#),
      "the image's markdown doesn't take its place in the draft")
    XCTAssertTrue(app.buttons["send"].firstMatch.isEnabled, "Send stays off once the image is in")
    keepScreen("image-pasted")
    // The caret follows the image's markdown, so what is typed next goes after it.
    box.typeText(" Done.")
    XCTAssertTrue(
      draft(box, matches: #"The plot: !\[image\.(png|jpeg)\]\(image:[0-9A-Z]{26}\) Done\."#),
      "what is typed after the image lands inside its markdown")

    app.buttons["send"].firstMatch.tap()
    let image = app.scrollViews["messages"].buttons
      .matching(NSPredicate(format: "label MATCHES %@", #"image\.(png|jpeg)"#)).firstMatch
    XCTAssertTrue(image.waitForExistence(timeout: 20), "the post doesn't show the image")
    XCTAssertLessThanOrEqual(image.frame.maxY, box.frame.minY, "the post is under the draft")
    keepScreen("image-posted")
  }

  /// With text copied, the draft's own Paste pastes the text, as it did before it took images.
  @MainActor func testStillPastesTextFromTheDraftsOwnMenu() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    let box = draft(app)
    box.tap()
    box.typeText("Text: ")
    UIPasteboard.general.string = "plain words"
    box.press(forDuration: 1.2)
    let paste = app.menuItems["Paste"].firstMatch
    XCTAssertTrue(paste.waitForExistence(timeout: 10), "the draft's menu has no Paste for text")
    paste.tap()
    XCTAssertTrue(
      draft(box, matches: #"Text: plain words"#),
      "text pasted from the draft's menu isn't in the draft")
  }

  /// Waits for the draft's text to match `pattern` whole.
  @MainActor private func draft(_ box: XCUIElement, matches pattern: String) -> Bool {
    let matching = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value MATCHES %@", pattern), object: box)
    return XCTWaiter().wait(for: [matching], timeout: 20) == .completed
  }

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
    expectInTheSideColumn(app, app.buttons["open-thread"].firstMatch)
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
