import BoardKit
import SwiftUI
import XCTest

@testable import Stellaris

/// The sky in the frame of each part of the inner display it fills, with a fixed clock and Reduce
/// Motion on, so each picture is the same on every run. The pictures go with the test's results
/// for review; these tests fail only when the sky can't be drawn.
final class SkySnapshotTests: XCTestCase {
  /// The sky's part of the inner display: beside the chat in landscape, flat and folded like a
  /// book alike, and above it in portrait, flat and on a tabletop alike, since the split is at the
  /// hinge line in every pose.
  static let frames = [
    Snapshot.Size(name: "landscape", size: CGSize(width: 475, height: 669)),
    Snapshot.Size(name: "portrait", size: CGSize(width: 669, height: 475)),
  ]
  static let clock = 1_000.0

  /// Draws the sample sky in each frame, at each type size given, after `prepare`, and keeps each
  /// picture as `sky-<name>-<frame>-<type>`.
  @MainActor private func record(
    _ name: String, types: [Snapshot.TypeSize] = [Snapshot.typeSizes[0]],
    prepare: (AppModel) -> Void = { _ in }
  ) async throws {
    for frame in SkySnapshotTests.frames {
      for type in types {
        let model = SkySample.app()
        prepare(model)
        let view = SkyView(fixedClock: SkySnapshotTests.clock, reduceMotion: true)
          .environment(model)
        let image = try await Snapshot.image(of: view, size: frame.size, type: type)
        try Snapshot.keep(image, named: "sky-\(name)-\(frame.name)-\(type.name)", in: self)
        // The sky is drawn: a citizen's star stands where the model puts it.
        let drawn = try XCTUnwrap(model.sky.lastFrame, "the sky drew no frame")
        XCTAssertEqual(drawn.stars.count, 7, "\(name) \(frame.name)")
      }
    }
  }

  @MainActor func testTheWholeSky() async throws {
    try await record("home")
  }

  @MainActor func testACitizensCard() async throws {
    try await record("card-citizen", types: Snapshot.typeSizes) { model in
      model.sky.card = .star("eng-1/demo")
    }
  }

  @MainActor func testATasksCard() async throws {
    try await record("card-task", types: Snapshot.typeSizes) { model in
      model.sky.card = .task(SkySample.id(1))
    }
  }

  @MainActor func testASpheresCard() async throws {
    try await record("card-sphere", types: Snapshot.typeSizes) { model in
      model.sky.card = .sphere("docs")
    }
  }

  /// With a project's channel open in Chat, the sky frames its sphere and brightens it.
  @MainActor func testAProjectInFocus() async throws {
    try await record("focus") { model in
      model.open(.channel("ops/general"))
    }
  }

  /// A post's first line, a second after it was posted.
  @MainActor func testALineRising() async throws {
    try await record("posted") { model in
      let sky = model.sky
      sky.scene.reducedMotion = true
      sky.scene.setModel(sky.model(projects: model.store.projects, tasks: model.store.tasks))
      sky.scene.step(
        at: SkySnapshotTests.clock - 1, in: SkyViewport(width: 475, height: 669))
      sky.scene.say("eng-1/demo", text: "The export view is in, with the design as approved")
    }
  }

  /// A zoom and a pan.
  @MainActor func testZoomedIn() async throws {
    try await record("zoomed") { model in
      let sky = model.sky
      sky.viewport = SkyViewport(width: 475, height: 669)
      sky.scene.reducedMotion = true
      sky.scene.setModel(sky.model(projects: model.store.projects, tasks: model.store.tasks))
      sky.scene.step(at: SkySnapshotTests.clock - 1, in: sky.viewport)
      sky.zoom(by: 2.5)
      sky.pan(dx: -80, dy: 40)
    }
  }
}
