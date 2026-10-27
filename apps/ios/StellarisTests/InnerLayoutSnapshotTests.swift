import BoardKit
import SwiftUI
import XCTest

@testable import Stellaris

/// The app in each pose over the fake board, with a draft in #general and the sky on a fixed clock
/// with Reduce Motion on: on the inner display the sky beside the chat in landscape and above it
/// in portrait, flat or folded alike, since the split is at the fold either way, the chat grown
/// over the sky while a keyboard 336 points tall is up in portrait, and a card in the sky's part;
/// and the chat alone on the outer display and in Split View. The fold is a band 21 points wide at
/// the middle, as the sign-in's tests have it, since what iOS reports there is checked on the
/// device. The pictures go with the test's results for review; the tests fail when a pose draws
/// the sky where it has none, or outside its part, or without the fold's band clear.
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
        pose: AppLayout.Pose(divisions: portrait.divisions, keyboardTop: 615, skyClock: clock),
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
          expectTheSky(model.sky.viewport, in: pose.size, on: side, pose.name)
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
      expectTheSky(model.sky.viewport, in: pose.size, on: try XCTUnwrap(pose.sky), pose.name)
    }
  }

  /// The sky's viewport spans the window one way and runs to the fold the other, with room for the
  /// fold's band; a safe area at the window's edges can add to it.
  private func expectTheSky(_ view: SkyViewport, in size: CGSize, on side: Side, _ pose: String) {
    let (width, height) = (Double(size.width), Double(size.height))
    let fold = side == .leading ? width / 2 : height / 2
    switch side {
    case .leading:
      XCTAssertEqual(view.height, height, accuracy: 1, pose)
      XCTAssertGreaterThanOrEqual(view.width, fold, pose)
      XCTAssertLessThan(view.width, width * 0.6, pose)
      XCTAssertGreaterThanOrEqual(view.right, InnerLayoutSnapshotTests.band, pose)
    case .top:
      XCTAssertEqual(view.width, width, accuracy: 1, pose)
      XCTAssertGreaterThanOrEqual(view.height, fold, pose)
      XCTAssertLessThan(view.height, height * 0.6, pose)
      XCTAssertGreaterThanOrEqual(view.bottom, InnerLayoutSnapshotTests.band, pose)
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
