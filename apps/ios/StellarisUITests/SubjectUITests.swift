import XCTest

/// Tasks and proposals: the strip above a task's or a proposal's thread, Advance at a stage that
/// waits on the user and none at one another citizen holds, Approve and Reject with a reason kept
/// through a swipe away, the plan and the charter from the bar, and a project's dashboard and tasks.
final class SubjectUITests: ShellTestCase {
  /// A task at a gate that waits on the user, "Approve the design".
  private let exportView = "00000000000000000000000010"
  /// A task whose stage eng-1 holds.
  private let emptyState = "00000000000000000000000012"
  /// A member proposal, a channel proposal, and a reallocation, each waiting on the user.
  private let memberProposal = "00000000000000000000000004"
  private let channelProposal = "00000000000000000000000006"
  private let reallocation = "00000000000000000000000008"

  /// A stage that waits on the user opens from Needs you with Advance in the bar; the note sent
  /// with it shows in the task's thread, and the task moves on to its next stage.
  @MainActor func testAdvancesAStageThatWaitsOnYou() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Needs you")
    pick(app, "stage-\(exportView)")
    let strip = app.buttons["task-strip"].firstMatch
    XCTAssertTrue(strip.waitForExistence(timeout: 20), "the task's thread shows no strip")
    XCTAssertTrue(
      strip.label.contains("Approve the design"), "the strip doesn't name the stage: \(strip.label)")
    keepScreen("task")
    pick(app, "advance")
    let note = app.textFields["advance-note"].firstMatch
    XCTAssertTrue(note.waitForExistence(timeout: 20), "Advance opens no sheet")
    note.tap()
    note.typeText("The design is approved.")
    keepScreen("advance")
    expectInTheSideColumn(app, app.buttons["advance-confirm"].firstMatch)
    pick(app, "advance-confirm")
    let posted = app.scrollViews["messages"].staticTexts
      .matching(NSPredicate(format: "label == %@", "The design is approved.")).firstMatch
    XCTAssertTrue(posted.waitForExistence(timeout: 20), "the note doesn't show in the thread")
    let moved = expectation(
      for: NSPredicate(format: "label CONTAINS %@", "Review it"), evaluatedWith: strip)
    wait(for: [moved], timeout: 20)
    XCTAssertFalse(app.buttons["advance"].exists, "Advance stays once the stage is done")
    keepScreen("advanced")
  }

  /// A task whose stage another citizen holds shows its strip and Plan, and no Advance.
  @MainActor func testOffersNoAdvanceAtAStageThatIsNotYours() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Board")
    pick(app, "task-\(emptyState)")
    let strip = app.buttons["task-strip"].firstMatch
    XCTAssertTrue(strip.waitForExistence(timeout: 20), "the task's thread shows no strip")
    XCTAssertTrue(strip.label.contains("held by eng-1"), "the strip names no holder: \(strip.label)")
    XCTAssertTrue(app.buttons["plan"].waitForExistence(timeout: 20), "the bar has no Plan")
    XCTAssertFalse(app.buttons["advance"].exists, "Advance at a stage eng-1 holds")
    keepScreen("task-not-yours")
  }

  /// Reject asks for a reason, which a swipe away keeps; the rejection shows in the strip, and
  /// closes the proposal's thread.
  @MainActor func testRejectsAProposalWithItsReason() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Needs you")
    pick(app, "proposal-\(reallocation)")
    let strip = app.buttons["proposal-strip"].firstMatch
    XCTAssertTrue(strip.waitForExistence(timeout: 20), "the proposal's thread shows no strip")
    XCTAssertTrue(strip.label.contains("for you to decide"), "the strip: \(strip.label)")
    XCTAssertTrue(app.buttons["approve"].waitForExistence(timeout: 20), "the bar has no Approve")
    keepScreen("proposal")
    pick(app, "reject")
    let reason = app.textFields["decision-reason"].firstMatch
    XCTAssertTrue(reason.waitForExistence(timeout: 20), "Reject opens no sheet")
    reason.tap()
    reason.typeText("One reviewer keeps up for now.")
    dragAway(app, app.navigationBars["Reject"].firstMatch)
    XCTAssertTrue(reason.waitForNonExistence(timeout: 20), "the sheet doesn't go")
    pick(app, "reject")
    XCTAssertTrue(reason.waitForExistence(timeout: 20), "Reject opens no sheet again")
    XCTAssertEqual(reason.value as? String, "One reviewer keeps up for now.")
    expectInTheSideColumn(app, app.buttons["decision-confirm"].firstMatch)
    pick(app, "decision-confirm")
    let decided = expectation(
      for: NSPredicate(format: "label CONTAINS %@", "Rejected by"), evaluatedWith: strip)
    wait(for: [decided], timeout: 20)
    XCTAssertFalse(app.buttons["approve"].exists, "Approve stays once the proposal is decided")
    XCTAssertFalse(draft(app).exists, "the decided proposal's thread still takes posts")
    keepScreen("rejected")
  }

  /// Approve, pinned in the bar, approves with no reason needed.
  @MainActor func testApprovesAProposal() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Needs you")
    pick(app, "proposal-\(channelProposal)")
    let strip = app.buttons["proposal-strip"].firstMatch
    XCTAssertTrue(strip.waitForExistence(timeout: 20), "the proposal's thread shows no strip")
    pick(app, "approve")
    XCTAssertTrue(
      app.textFields["decision-reason"].waitForExistence(timeout: 20), "Approve opens no sheet")
    expectInTheSideColumn(app, app.buttons["decision-confirm"].firstMatch)
    pick(app, "decision-confirm")
    let decided = expectation(
      for: NSPredicate(format: "label CONTAINS %@", "Approved by"), evaluatedWith: strip)
    wait(for: [decided], timeout: 20)
    XCTAssertFalse(app.buttons["approve"].exists, "Approve stays once the proposal is decided")
    keepScreen("approved")
  }

  /// Plan opens a task's stages, and Charter a proposal's charter, in a sheet with no button,
  /// each closed again by a drag down.
  @MainActor func testOpensThePlanAndTheCharter() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Needs you")
    pick(app, "stage-\(exportView)")
    pick(app, "plan")
    let stage = app.descendants(matching: .any)["stage-s2"].firstMatch
    XCTAssertTrue(stage.waitForExistence(timeout: 20), "Plan shows no stages")
    XCTAssertTrue(stage.label.contains("gate"), "the stage doesn't say it is a gate")
    keepScreen("plan")
    XCTAssertFalse(app.buttons["Done"].exists, "the plan's sheet has a Done")
    dragAway(app, app.navigationBars["Plan"].firstMatch)
    XCTAssertTrue(stage.waitForNonExistence(timeout: 20), "a drag down leaves the plan open")

    tab(app, "Needs you")
    pick(app, "proposal-\(memberProposal)")
    pick(app, "charter")
    let charter = app.descendants(matching: .any)["charter-\(memberProposal)"].firstMatch
    XCTAssertTrue(charter.waitForExistence(timeout: 20), "Charter shows no charter")
    let field = charter.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "CLI and model")).firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 20), "the charter shows no member's fields")
    keepScreen("charter")
    XCTAssertFalse(app.buttons["Done"].exists, "the charter's sheet has a Done")
    dragAway(app, app.navigationBars["Charter"].firstMatch)
    XCTAssertTrue(charter.waitForNonExistence(timeout: 20), "a drag down leaves the charter open")
  }

  /// At the largest type size, the plan and Settings close with a drag down, and Advance's Cancel
  /// still stands in the side column. The app is signed in at the default size and launched again
  /// at the largest, which the snapshot harness can't show: its sheets never cover the column.
  @MainActor func testClosesTheSheetsAtTheLargestSize() {
    var app = launch()
    signIn(app)
    expectGeneral(app)
    app.terminate()
    app = launch(
      reset: false,
      arguments: [
        "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
      ])
    expectGeneral(app)
    tab(app, "Needs you")
    // At this size the proposals push the stage below the screen, where the list builds no row.
    let list = app.collectionViews.firstMatch
    XCTAssertTrue(list.waitForExistence(timeout: 20), "Needs you shows no list")
    let row = app.buttons["stage-\(exportView)"].firstMatch
    for _ in 0..<12 where !(row.exists && row.isHittable) {
      let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.7))
      let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.3))
      start.press(forDuration: 0.1, thenDragTo: end)
    }
    XCTAssertTrue(row.exists && row.isHittable, "the stage isn't in Needs you")
    row.tap()
    pick(app, "plan")
    let stage = app.descendants(matching: .any)["stage-s2"].firstMatch
    XCTAssertTrue(stage.waitForExistence(timeout: 20), "Plan shows no stages")
    keepScreen("plan-largest")
    dragAway(app, app.navigationBars["Plan"].firstMatch)
    XCTAssertTrue(stage.waitForNonExistence(timeout: 20), "a drag down leaves the plan open")
    pick(app, "advance")
    let note = app.textFields["advance-note"].firstMatch
    XCTAssertTrue(note.waitForExistence(timeout: 20), "Advance opens no sheet")
    keepScreen("advance-largest")
    expectInTheSideColumn(app, app.buttons["advance-cancel"].firstMatch)
    pick(app, "advance-cancel")
    XCTAssertTrue(note.waitForNonExistence(timeout: 20), "Cancel leaves the sheet open")
    tab(app, "Board")
    pick(app, "settings")
    XCTAssertTrue(app.staticTexts["settings-board"].waitForExistence(timeout: 20))
    keepScreen("settings-largest")
    dragAway(app, app.navigationBars["Settings"].firstMatch)
    let board = app.staticTexts["settings-board"].firstMatch
    XCTAssertTrue(board.waitForNonExistence(timeout: 20), "a drag down leaves Settings open")
  }

  /// A project's dashboard and its tasks by where they stand open under Board; a task opens in
  /// Chat.
  @MainActor func testOpensAProjectsDashboardAndTasks() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Board")
    pick(app, "project-demo")
    let dashboard = app.staticTexts
      .matching(NSPredicate(format: "label CONTAINS %@", "Export view: waiting on the design"))
      .firstMatch
    XCTAssertTrue(dashboard.waitForExistence(timeout: 20), "the project shows no dashboard")
    // Section headers may be drawn in capitals, and as text or as headers.
    func header(_ words: String) -> XCUIElement {
      app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] %@", words))
        .firstMatch
    }
    XCTAssertTrue(
      header("Waiting for a holder · 1").waitForExistence(timeout: 20),
      "the tasks aren't grouped by where they stand")
    XCTAssertTrue(header("Being worked · 1").exists)
    keepScreen("project")
    pick(app, "project-task-\(emptyState)")
    expectConversation(app, "Fix the empty state")
  }
}
