import XCTest

/// A task's changes at the plan's end: a file's row pushes its change on the plan's stack, Whole
/// file and a line's number open the file on the task's branch, and the section says in the web's
/// words why it can't list them.
final class ChangesUITests: ShellTestCase {
  private let exportView = "00000000000000000000000010"

  /// The plan ends with the files the task's branch changed, each with what happened to it; a row
  /// opens the file's change with its lines numbered, and Whole file opens the file. Opened again,
  /// a line's number opens the file at that line, marked and on screen.
  @MainActor func testOpensAChangeThenTheWholeFileFromThePlan() {
    let app = openPlan(token: "fixture-token")
    let row = app.buttons["change-src/export/view.ts"].firstMatch
    dragUpTo(app, row)
    XCTAssertTrue(row.label.contains("+5 −2"), "the change's row says \(row.label)")
    let deleted = app.buttons["change-src/export/old.ts"].firstMatch
    XCTAssertTrue(deleted.label.contains("deleted"), "the deleted file's row says \(deleted.label)")
    keepScreen("plan-files")
    row.tap()
    let nine = app.buttons["patch-line-9"].firstMatch
    XCTAssertTrue(nine.waitForExistence(timeout: 20), "the change shows no numbered line")
    XCTAssertFalse(
      app.buttons["patch-line-1"].exists, "a line above the hunk is numbered as in the change")
    keepScreen("change")
    pick(app, "whole-file")
    let first = app.descendants(matching: .any)["line-1"].firstMatch
    XCTAssertTrue(first.waitForExistence(timeout: 20), "Whole file doesn't open the file")
    XCTAssertFalse(first.isSelected, "Whole file marks a line")
    keepScreen("change-whole-file")

    // Closing the plan drops what it pushed; opened again it shows the plan, whose row opens the
    // change once more, and a line's number there opens the file at that line.
    dragAway(app, app.navigationBars["view.ts"].firstMatch)
    XCTAssertTrue(first.waitForNonExistence(timeout: 20), "a drag down leaves the file open")
    pick(app, "plan")
    dragUpTo(app, row)
    row.tap()
    XCTAssertTrue(nine.waitForExistence(timeout: 20), "the change didn't open again")
    nine.tap()
    let cited = app.descendants(matching: .any)["line-9"].firstMatch
    XCTAssertTrue(cited.waitForExistence(timeout: 20), "a line's number doesn't open the file")
    XCTAssertTrue(cited.isSelected, "the line the number names isn't marked")
    XCTAssertTrue(cited.isHittable, "the line the number names isn't on screen")
    keepScreen("change-cited-line")
  }

  /// With the project's runner away, and before any turn made the task's branch, the plan's Files
  /// says so in the web's words.
  @MainActor func testSaysWhyTheChangesCantBeListed() {
    for (token, words) in [
      (
        "runner-away",
        "runner-1, the runner Demo lives on, is not connected, so the task's files cannot be listed now."
      ),
      ("no-branch", "Nothing on task/\(exportView) yet."),
    ] {
      let app = openPlan(token: token)
      let state = app.staticTexts["changes-state"].firstMatch
      dragUpTo(app, state)
      XCTAssertEqual(state.label, words, "Files doesn't say why it lists nothing")
      keepScreen("plan-files-\(token)")
    }
  }

  /// The app signed in with `token`, at the export task's plan, opened from Needs you.
  @MainActor private func openPlan(token: String) -> XCUIApplication {
    let app = launch()
    signIn(app, token: token)
    expectGeneral(app)
    tab(app, "Needs you")
    pick(app, "stage-\(exportView)")
    pick(app, "plan")
    XCTAssertTrue(
      app.descendants(matching: .any)["stage-s2"].firstMatch.waitForExistence(timeout: 20),
      "Plan shows no stages")
    return app
  }
}
