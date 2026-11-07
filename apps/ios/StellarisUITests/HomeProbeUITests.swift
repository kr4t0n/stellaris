import XCTest

/// Probe only: finds the app's icon on the Home Screen and walks SpringBoard's Customize sheet,
/// printing what it lists and keeping a picture at each step.
final class HomeProbeUITests: XCTestCase {
  @MainActor var springboard: XCUIApplication {
    XCUIApplication(bundleIdentifier: "com.apple.springboard")
  }

  @MainActor func keep(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = "home-\(name).png"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  @MainActor func dump(_ step: String) {
    let buttons = springboard.buttons.allElementsBoundByIndex.map {
      "\($0.label)|\($0.identifier)|\($0.frame)"
    }
    print("HOMEPROBE \(step) buttons = \(buttons)")
    let icons = springboard.icons.allElementsBoundByIndex.map { "\($0.label)|\($0.frame)" }
    print("HOMEPROBE \(step) icons = \(icons)")
    let others = springboard.otherElements.allElementsBoundByIndex.prefix(80).map {
      "\($0.label)|\($0.identifier)"
    }
    print("HOMEPROBE \(step) others = \(others)")
    keep(step)
  }

  @MainActor func tapFirst(_ labels: [String], _ step: String) -> Bool {
    for label in labels {
      let button = springboard.buttons[label].firstMatch
      if button.waitForExistence(timeout: 3) {
        print("HOMEPROBE \(step) tapping \(label)")
        button.tap()
        sleep(2)
        return true
      }
    }
    print("HOMEPROBE \(step) found none of \(labels)")
    return false
  }

  @MainActor func tapNow(_ label: String) -> Bool {
    let button = springboard.buttons[label].firstMatch
    let element =
      button.waitForExistence(timeout: 5)
      ? button : springboard.descendants(matching: .any)[label].firstMatch
    let found = element.waitForExistence(timeout: 2)
    print("HOMEPROBE \(label) exists \(found)")
    guard found else { return false }
    if element.isHittable {
      element.tap()
    } else {
      element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
    return true
  }

  @MainActor func enterCustomize() -> Bool {
    for attempt in 1...3 {
      springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.6)).press(forDuration: 2)
      if tapNow("Edit") {
        sleep(1)
        if tapNow("Customize") {
          return true
        }
      }
      print("HOMEPROBE customize attempt \(attempt) missed")
      springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
      sleep(2)
    }
    return false
  }

  /// Sets the Home Screen's icons to `tile`, with `mode` from the sheet's segmented control, then
  /// closes the sheet, leaves editing, and keeps a picture as `name`.
  @MainActor func show(_ name: String, _ tile: String, _ mode: String) {
    guard enterCustomize() else { return XCTFail("no Customize for \(name)") }
    sleep(1)
    let button = springboard.buttons[tile].firstMatch
    XCTAssertTrue(button.waitForExistence(timeout: 5), "no \(tile)")
    button.tap()
    sleep(1)
    let segment = springboard.segmentedControls.firstMatch.buttons[mode]
    if segment.waitForExistence(timeout: 5) {
      segment.tap()
    } else {
      print("HOMEPROBE \(name): no segment \(mode)")
    }
    sleep(2)
    keep("sheet-\(name)")
    // A tap on the wallpaper above the sheet closes it; Done leaves editing.
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
    sleep(1)
    let done = springboard.buttons["Done"].firstMatch
    if done.waitForExistence(timeout: 3) {
      done.tap()
    }
    sleep(2)
    print("HOMEPROBE \(name) shown, Done \(done.exists), sheet \(springboard.navigationBars["Customize"].exists)")
    keep("icon-\(name)")
  }

  @MainActor func testShowsTheIconInEachAppearance() {
    continueAfterFailure = true
    sleep(3)
    keep("0-start")
    show("1-default", "Default", "Light")
    show("2-dark", "Dark", "Always")
    show("3-clear-light", "Clear", "Light")
    show("4-clear-dark", "Clear", "Dark")
    show("5-tinted-light", "Tinted", "Light")
    show("6-tinted-dark", "Tinted", "Dark")
    show("7-default-again", "Default", "Light")
  }
}
