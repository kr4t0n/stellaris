import XCTest

/// The bar against the draft on the outer display, where iOS stands a bar's symbols in the side
/// column at the window's trailing edge, and the draft puts Send in the same column while the
/// keyboard is up, on the keyboard's top (`ComposerPlacement`). In each kind of conversation that
/// takes posts, no symbol of the bar may meet Send, nor the capsule. Only a channel is measured
/// without Back: a thread always has it, to its channel when Chat came from nowhere else. A decided
/// proposal's thread takes no posts, so it has no draft to meet.
final class BarUITests: ShellTestCase {
  /// A task at a gate that waits on the user, and one whose stage eng-1 holds.
  private let exportView = "00000000000000000000000010"
  private let emptyState = "00000000000000000000000012"
  /// A reallocation and a channel proposal, each waiting on the user.
  private let reallocation = "00000000000000000000000008"
  private let channelProposal = "00000000000000000000000006"

  /// The tabs, which the side column holds below the bar's symbols, under the keyboard while it
  /// is up.
  private let tabs: Set<String> = ["Chat", "Board", "Needs you"]

  private enum Kind: String, CaseIterable {
    case channel, thread
    case taskYours = "task-yours"
    case task
    case proposalYours = "proposal-yours"
    case proposalDecided = "proposal-decided"
  }

  /// #general on a fresh start, with no Back, then each other kind of conversation from a fresh
  /// start of its own, so each opens with the keyboard down. Every frame is kept with the test's
  /// results beside a picture, and every symbol that meets the draft is named at the end.
  @MainActor func testNoSymbolOfTheBarMeetsTheDraft() {
    var app = launch()
    signIn(app)
    expectGeneral(app)
    var met = measure(app, "general", ready: app.buttons["new-thread"].firstMatch)
    var waiting: [String] = []
    for kind in Kind.allCases {
      app.terminate()
      app = launch(reset: false)
      expectGeneral(app)
      let ready = open(kind, in: app)
      switch kind {
      case .proposalDecided:
        XCTAssertTrue(draft(app).waitForNonExistence(timeout: 20), "a decided proposal takes posts")
        keep(app, kind.rawValue, "down", column(app), [:])
      case .proposalYours:
        waiting = measure(app, kind.rawValue, ready: ready)
      default:
        met += measure(app, kind.rawValue, ready: ready)
      }
    }
    XCTAssertTrue(met.isEmpty, "the bar meets the draft: " + met.joined(separator: "; "))
    // Back, Approve, Reject and Charter: the third and the fourth stand where Send does.
    XCTExpectFailure("a proposal waiting on the user has four symbols in its bar") {
      XCTAssertTrue(waiting.isEmpty, "the bar meets the draft: " + waiting.joined(separator: "; "))
    }
  }

  /// Opens a conversation of `kind` in Chat, and gives what shows once its bar is complete.
  @MainActor private func open(_ kind: Kind, in app: XCUIApplication) -> XCUIElement {
    switch kind {
    case .channel:
      tab(app, "Board")
      pick(app, "channel-asks")
      return app.buttons["new-thread"].firstMatch
    case .thread:
      let samples = app.scrollViews["messages"].links["rendering samples"].firstMatch
      XCTAssertTrue(samples.waitForExistence(timeout: 20), "#general holds no link to the samples")
      samples.tap()
      let newest = app.scrollViews["messages"].staticTexts["message-samples-6"].firstMatch
      XCTAssertTrue(newest.waitForExistence(timeout: 20), "the samples don't open in Chat")
      return app.buttons["back"].firstMatch
    case .taskYours:
      tab(app, "Needs you")
      pick(app, "stage-\(exportView)")
      return app.buttons["advance"].firstMatch
    case .task:
      tab(app, "Board")
      pick(app, "task-\(emptyState)")
      return app.buttons["task-strip"].firstMatch
    case .proposalYours:
      tab(app, "Needs you")
      pick(app, "proposal-\(reallocation)")
      return app.buttons["approve"].firstMatch
    case .proposalDecided:
      tab(app, "Needs you")
      pick(app, "proposal-\(channelProposal)")
      let strip = app.buttons["proposal-strip"].firstMatch
      XCTAssertTrue(strip.waitForExistence(timeout: 20), "the proposal's thread shows no strip")
      pick(app, "approve")
      pick(app, "decision-confirm")
      let decided = expectation(
        for: NSPredicate(format: "label CONTAINS %@", "Approved by"), evaluatedWith: strip)
      wait(for: [decided], timeout: 20)
      return strip
    }
  }

  /// Measures the side column against the draft in the conversation Chat shows, once `ready`
  /// shows, with the keyboard down and then up, and gives each symbol of the bar that meets the
  /// capsule or Send.
  @MainActor private func measure(_ app: XCUIApplication, _ name: String, ready: XCUIElement)
    -> [String]
  {
    XCTAssertTrue(ready.waitForExistence(timeout: 20), "\(name)'s bar isn't complete")
    let box = draft(app)
    XCTAssertTrue(box.waitForExistence(timeout: 20), "\(name) shows no draft")
    // Once the bar has finished moving in.
    RunLoop.current.run(until: .now.addingTimeInterval(1))
    let capsule = app.otherElements["composer"].firstMatch
    let down = column(app)
    keep(app, name, "down", down, ["capsule": capsule.frame])
    var met = meeting(down, capsule.frame, "the capsule, keyboard down")

    box.tap()
    let send = app.buttons["send"].firstMatch
    XCTAssertTrue(send.waitForExistence(timeout: 20), "focusing \(name)'s draft shows no Send")
    let keyboard = risen(app)
    let up = column(app)
    keep(app, name, "up", up, ["capsule": capsule.frame, "send": send.frame, "keyboard": keyboard])
    met += meeting(up, send.frame, "Send")
    met += meeting(up, capsule.frame, "the capsule, keyboard up")
    return met.map { "\(name): \($0)" }
  }

  /// The keyboard's frame once it has finished rising.
  @MainActor private func risen(_ app: XCUIApplication) -> CGRect {
    let keyboard = app.keyboards.firstMatch
    XCTAssertTrue(keyboard.waitForExistence(timeout: 20), "no keyboard came up")
    var frame = keyboard.frame
    let deadline = Date.now.addingTimeInterval(5)
    while Date.now < deadline {
      RunLoop.current.run(until: .now.addingTimeInterval(0.25))
      let now = keyboard.frame
      if now == frame {
        break
      }
      frame = now
    }
    // Send and the bar move with it.
    RunLoop.current.run(until: .now.addingTimeInterval(0.5))
    return frame
  }

  /// The buttons in the side column, but Send and the tabs, top first, from one snapshot of the
  /// app, which leaves out the keyboard's own keys.
  @MainActor private func column(_ app: XCUIApplication) -> [(name: String, frame: CGRect)] {
    let window = app.windows.firstMatch.frame
    guard let root = try? app.snapshot() else {
      XCTFail("the app gives no snapshot")
      return []
    }
    var found: [(name: String, frame: CGRect)] = []
    var stack: [any XCUIElementSnapshot] = [root]
    while let node = stack.popLast() {
      if node.elementType == .keyboard {
        continue
      }
      stack += node.children
      let frame = node.frame
      guard node.elementType == .button, frame.width > 0, frame.height > 0,
        window.intersects(frame), frame.midX > window.maxX - 70,
        node.identifier != "send", !tabs.contains(node.label)
      else {
        continue
      }
      let name = node.identifier.isEmpty ? node.label : node.identifier
      if !found.contains(where: { $0.name == name && $0.frame == frame }) {
        found.append((name: name, frame: frame))
      }
    }
    return found.sorted { $0.frame.minY < $1.frame.minY }
  }

  /// Each symbol in `column` whose frame meets `target`'s, by more than an edge.
  private func meeting(
    _ column: [(name: String, frame: CGRect)], _ target: CGRect, _ what: String
  ) -> [String] {
    column.compactMap { symbol in
      let overlap = symbol.frame.intersection(target)
      guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else {
        return nil
      }
      return "\(symbol.name) \(described(symbol.frame)) meets \(what) \(described(target))"
    }
  }

  /// Keeps the frames measured with the keyboard `state`, and a picture of the screen, with the
  /// test's results, and prints them to its log.
  @MainActor private func keep(
    _ app: XCUIApplication, _ name: String, _ state: String,
    _ column: [(name: String, frame: CGRect)], _ others: [String: CGRect]
  ) {
    let window = app.windows.firstMatch.frame
    var lines = ["window \(described(window))"]
    lines += others.sorted { $0.key < $1.key }.map { "\($0.key) \(described($0.value))" }
    lines += column.map { "bar \($0.name) \(described($0.frame))" }
    let text = lines.joined(separator: "\n")
    print("bar: \(name), keyboard \(state)\n\(text)")
    let attachment = XCTAttachment(string: text)
    attachment.name = "bar-\(name)-keyboard-\(state).txt"
    attachment.lifetime = .keepAlways
    add(attachment)
    keepScreen("bar-\(name)-keyboard-\(state)")
  }

  /// A frame as its spans across and down, in points.
  private func described(_ frame: CGRect) -> String {
    String(
      format: "x %.1f–%.1f y %.1f–%.1f", frame.minX, frame.maxX, frame.minY, frame.maxY)
  }
}
