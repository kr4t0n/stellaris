import BoardKit
import SwiftUI
import XCTest

@testable import Stellaris

/// The app in each pose over the fake board, with a draft in #general and the sky on a fixed clock
/// with Reduce Motion on: on the inner display the sky beside the chat in landscape and above it
/// in portrait, flat or folded alike, since the split is at the fold either way, the chat grown
/// over the sky while a keyboard 336 points tall is up in portrait, and a card in the sky's part;
/// and the chat alone on the outer display and in Split View. The fold is a band 21 points wide at
/// the middle of the window, as the sign-in's tests have it and as the device's hinge would be,
/// which the layout reads in its own coordinates, below the window's safe area, as it does what
/// iOS reports; where the real fold lies is checked on the device. The pictures go with the test's
/// results for review; the tests fail when a pose draws the sky where it has none, or anywhere but
/// up to the fold, or without the fold's band clear.
final class InnerLayoutSnapshotTests: XCTestCase {
  /// Where the sky's part is: beside the chat or above it, as far as the fold.
  private enum Side {
    case leading, top
  }

  private struct Pose {
    let name: String
    let size: CGSize
    let pose: AppLayout.Pose
    let sky: Side?
  }

  /// The fold's band.
  private static let band = 21.0

  private static let clock = 1_000.0
  private static let landscape = AppLayout.Pose(
    divisions: [CGRect(x: 465, y: 0, width: 21, height: 669)], skyClock: clock)
  private static let portrait = AppLayout.Pose(
    divisions: [CGRect(x: 0, y: 465, width: 669, height: 21)], skyClock: clock)

  private let poses: [Pose] = {
    let test = InnerLayoutSnapshotTests.self
    let (landscape, portrait, clock) = (test.landscape, test.portrait, test.clock)
    return [
      Pose(
        name: "landscape", size: CGSize(width: 951, height: 669), pose: landscape, sky: .leading),
      Pose(name: "portrait", size: CGSize(width: 669, height: 951), pose: portrait, sky: .top),
      Pose(
        name: "portrait-typing", size: CGSize(width: 669, height: 951),
        pose: AppLayout.Pose(divisions: portrait.divisions, keyboard: 336, skyClock: clock),
        sky: nil),
      Pose(
        name: "outer", size: CGSize(width: 466, height: 678),
        pose: AppLayout.Pose(divisions: [], skyClock: clock), sky: nil),
      Pose(
        name: "split-view", size: CGSize(width: 320, height: 678),
        pose: AppLayout.Pose(divisions: [], skyClock: clock), sky: nil),
    ]
  }()

  @MainActor func testThePoses() async throws {
    let model = try await signedIn()
    for pose in poses {
      let types = pose.sky == nil ? [Snapshot.typeSizes[0]] : Snapshot.typeSizes
      for type in types {
        model.sky.lastFrame = nil
        let image = try await Snapshot.image(
          of: AppLayout(pose: pose.pose).environment(model), size: pose.size, type: type)
        try Snapshot.keep(image, named: "inner-\(pose.name)-\(type.name)", in: self)
        if let side = pose.sky {
          XCTAssertNotNil(model.sky.lastFrame, "\(pose.name): no sky")
          expectTheSky(model.sky.viewport, in: pose, on: side)
        } else if pose.name != "portrait-typing" {
          XCTAssertNil(model.sky.lastFrame, "\(pose.name): a sky with the chat alone")
        }
      }
    }
  }

  /// A star's card opens at the foot of the sky's part, clear of the fold and of the chat.
  @MainActor func testACardInTheSkysPart() async throws {
    let model = try await signedIn()
    for pose in poses.prefix(2) {
      model.sky.card = .star("eng-1")
      let image = try await Snapshot.image(
        of: AppLayout(pose: pose.pose).environment(model), size: pose.size,
        type: Snapshot.typeSizes[0])
      try Snapshot.keep(image, named: "inner-\(pose.name)-card", in: self)
      // The card keeps to the sky's viewport less its room, which holds the fold's band.
      expectTheSky(model.sky.viewport, in: pose, on: try XCTUnwrap(pose.sky))
    }
  }

  /// The sky's viewport, which runs out to the window's edges, spans the window one way and ends
  /// at the far edge of the fold's band the other, in the window as in the pose, with room for the
  /// band.
  private func expectTheSky(_ view: SkyViewport, in pose: Pose, on side: Side) {
    let (width, height) = (Double(pose.size.width), Double(pose.size.height))
    guard let fold = pose.pose.divisions.first else {
      return XCTFail("\(pose.name): no fold")
    }
    switch side {
    case .leading:
      XCTAssertEqual(view.height, height, accuracy: 1, pose.name)
      XCTAssertEqual(view.width, Double(fold.maxX), accuracy: 1, pose.name)
      XCTAssertGreaterThanOrEqual(view.right, InnerLayoutSnapshotTests.band, pose.name)
    case .top:
      XCTAssertEqual(view.width, width, accuracy: 1, pose.name)
      XCTAssertEqual(view.height, Double(fold.maxY), accuracy: 1, pose.name)
      XCTAssertGreaterThanOrEqual(view.bottom, InnerLayoutSnapshotTests.band, pose.name)
    }
  }

  /// Signed in to the fake board, with #general and the sky loaded and a draft in #general.
  @MainActor private func signedIn() async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: "fixture-token")
    try await waitUntilLoaded(model)
    await model.feed(for: .general).load(using: model)
    await model.sky.load(using: model)
    model.memory?.setDraft("Half a thought", for: .general)
    return model
  }
}
