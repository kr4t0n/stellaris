import XCTest

/// A probe, not for the repository: holds rows of Board and Needs you for three seconds each, so the
/// test's screen recording shows how a pressed row draws.
final class PressProbeUITests: ShellTestCase {
  @MainActor func testHoldsRows() {
    let app = launch()
    signIn(app)
    expectGeneral(app)
    tab(app, "Board")
    let task = app.buttons["task-00000000000000000000000012"].firstMatch
    XCTAssertTrue(task.waitForExistence(timeout: 20))
    print("probe: hold task row at \(Date().timeIntervalSince1970)")
    task.press(forDuration: 3)
    tab(app, "Board")
    let project = app.buttons["project-demo"].firstMatch
    XCTAssertTrue(project.waitForExistence(timeout: 20))
    print("probe: hold project row at \(Date().timeIntervalSince1970)")
    project.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).press(forDuration: 3)
    tab(app, "Needs you")
    let stage = app.buttons["stage-00000000000000000000000010"].firstMatch
    XCTAssertTrue(stage.waitForExistence(timeout: 20))
    print("probe: hold stage row at \(Date().timeIntervalSince1970)")
    stage.press(forDuration: 3)
    print("probe: done at \(Date().timeIntervalSince1970)")
    XCTFail("probe: fails on purpose, so XCTest keeps the screen recording")
  }
}
