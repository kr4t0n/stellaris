import BoardKit
import SwiftUI
import UIKit
import XCTest

@testable import Stellaris

/// The sky's camera as VoiceOver reaches it. XCTest's UI tests can't perform an accessibility
/// action, so this test hosts the sky in the app, finds the camera's element in the accessibility
/// tree UIKit builds for it, and calls what VoiceOver calls: its activation and its named actions.
final class SkyAccessibilityTests: XCTestCase {
  /// The element with `identifier` under `element`, through accessibility containers and views.
  @MainActor private func find(_ identifier: String, in element: NSObject, depth: Int = 0)
    -> NSObject?
  {
    guard depth < 40 else { return nil }
    if (element as? UIAccessibilityIdentification)?.accessibilityIdentifier == identifier {
      return element
    }
    var children: [NSObject] = (element.accessibilityElements ?? []).compactMap { $0 as? NSObject }
    let count = element.accessibilityElementCount()
    if children.isEmpty, count != NSNotFound, count > 0 {
      children = (0..<count).compactMap { element.accessibilityElement(at: $0) as? NSObject }
    }
    if let view = element as? UIView {
      children += view.subviews
    }
    for child in children {
      if let found = find(identifier, in: child, depth: depth + 1) {
        return found
      }
    }
    return nil
  }

  /// Performs a custom action as VoiceOver does, through its handler or its target.
  @MainActor private func perform(_ action: UIAccessibilityCustomAction) -> Bool {
    if let handler = action.actionHandler {
      return handler(action)
    }
    guard let target = action.target as? NSObject else {
      return false
    }
    _ = target.perform(action.selector, with: action)
    return true
  }

  /// Activating the camera's element takes a camera the user moved back to the whole sky, and its
  /// Zoom in zooms; the sky shows no button for either.
  @MainActor func testTheCameraElementTakesTheSkyHome() async throws {
    let model = SkySample.app()
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
      "the test host has no window scene")
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 475, height: 669)
    let host = UIHostingController(
      rootView: SkyView(fixedClock: 1_000, reduceMotion: true).environment(model))
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(600))
    host.view.layoutIfNeeded()

    model.sky.pan(dx: 60, dy: -30)
    model.sky.zoom(by: 2)
    XCTAssertEqual(model.sky.camera.mode, .manual)
    try await Task.sleep(for: .milliseconds(300))

    let camera = try XCTUnwrap(
      find("sky-camera", in: host.view), "VoiceOver finds no element for the sky's camera")
    XCTAssertEqual(camera.accessibilityLabel, "Fit the whole sky")
    XCTAssertTrue(camera.accessibilityTraits.contains(.button))
    XCTAssertNil(find("sky-fit", in: host.view), "the sky still has a Fit button")

    let scale = model.sky.camera.target.scale
    let zoomIn = try XCTUnwrap(
      camera.accessibilityCustomActions?.first { $0.name == "Zoom in" }, "no Zoom in action")
    XCTAssertTrue(perform(zoomIn))
    XCTAssertGreaterThan(model.sky.camera.target.scale, scale)
    XCTAssertNotNil(camera.accessibilityCustomActions?.first { $0.name == "Zoom out" })

    XCTAssertTrue(camera.accessibilityActivate())
    XCTAssertEqual(model.sky.camera.mode, .home)
  }
}
