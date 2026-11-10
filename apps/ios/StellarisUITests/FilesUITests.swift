import XCTest

/// A branch's files: a project's default branch from Board, a folder in it, markdown whose link
/// opens the code beside it at the line it cites, a table, and the board's words for a runner away
/// and for a branch with nothing on it yet.
final class FilesUITests: ShellTestCase {
  /// Board's Files row opens the project's default branch, folders before files, with whose
  /// commit it shows; a file of markdown reads as a message does, and its link to the code opens
  /// that file with the cited line marked and on screen.
  @MainActor func testOpensAProjectsBranchAndACitedLine() {
    let app = openFiles(token: "fixture-token")
    let folder = app.buttons["file-src"].firstMatch
    XCTAssertTrue(folder.waitForExistence(timeout: 20), "Files lists no folder of the branch")
    let readme = app.buttons["file-README.md"].firstMatch
    XCTAssertTrue(readme.waitForExistence(timeout: 20), "Files lists no file of the branch")
    XCTAssertLessThan(folder.frame.minY, readme.frame.minY, "a file comes before a folder")
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "committed by eng-1"))
        .firstMatch.exists,
      "Files doesn't say whose commit it shows")
    keepScreen("files-root")

    readme.tap()
    let text = app.staticTexts
      .matching(NSPredicate(format: "label CONTAINS %@", "turns a channel's messages"))
      .firstMatch
    XCTAssertTrue(text.waitForExistence(timeout: 20), "the readme doesn't read as markdown")
    keepScreen("files-markdown")
    let link = app.links["the export"].firstMatch
    XCTAssertTrue(link.waitForExistence(timeout: 20), "the readme's link to the code isn't a link")
    link.tap()
    let cited = app.descendants(matching: .any)["line-30"].firstMatch
    XCTAssertTrue(cited.waitForExistence(timeout: 20), "the link doesn't open the code")
    XCTAssertTrue(cited.isSelected, "the cited line isn't marked")
    XCTAssertTrue(cited.isHittable, "the cited line isn't on screen")
    keepScreen("files-cited-line")
  }

  /// A folder opens its own list, and a file in it its numbered lines.
  @MainActor func testOpensAFolderAndAFileInIt() {
    let app = openFiles(token: "fixture-token")
    pick(app, "file-src")
    pick(app, "file-src/app.ts")
    let first = app.descendants(matching: .any)["line-1"].firstMatch
    XCTAssertTrue(first.waitForExistence(timeout: 20), "the code shows no numbered lines")
    XCTAssertFalse(first.isSelected, "a line is marked though none is cited")
    keepScreen("files-code")
  }

  /// A table shows its cells, a quoted one whole.
  @MainActor func testShowsATable() {
    let app = openFiles(token: "fixture-token")
    pick(app, "file-results.csv")
    XCTAssertTrue(
      app.staticTexts["0.52, cold"].firstMatch.waitForExistence(timeout: 20),
      "the table doesn't show a quoted cell whole")
    keepScreen("files-table")
  }

  /// With the project's runner away, Files says so in the board's words; with nothing on the
  /// branch yet, it says that.
  @MainActor func testSaysWhenTheRunnerIsAwayOrTheBranchIsEmpty() {
    for (token, words) in [
      (
        "runner-away",
        "runner-1, the runner Demo lives on, is not connected, so the project's files cannot be read now."
      ),
      ("empty-branch", "Nothing on main yet."),
    ] {
      let app = openFiles(token: token)
      XCTAssertTrue(
        app.staticTexts[words].firstMatch.waitForExistence(timeout: 20),
        "Files doesn't say \(words)")
      keepScreen("files-\(token)")
    }
  }

  /// The app signed in with `token`, at the demo project's files under Board.
  @MainActor private func openFiles(token: String) -> XCUIApplication {
    let app = launch()
    signIn(app, token: token)
    expectGeneral(app)
    tab(app, "Board")
    pick(app, "project-files-demo")
    return app
  }
}
