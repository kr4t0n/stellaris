import Foundation
import Testing

@testable import BoardKit

/// The scene's port moves as the web's scene does. `apps/ios/fixtures/sky/scene.json` holds
/// sequences the web's `scene.test.ts` played through the real `SkyScene`, on a canvas that only
/// records, with what each sampled frame held: the camera, every body, mark, sphere, and rising
/// line, some of the specks, and each citizen's name where it was drawn. Here the same sequences
/// play through BoardKit's `SkyScene`, and every sample must agree, numbers within a millionth.
@Suite struct SkySceneTableTests {
  struct View: Decodable {
    let width, height, left, right: Double

    var viewport: SkyViewport {
      SkyViewport(width: width, height: height, left: left, right: right)
    }
  }

  /// What a sequence does before a frame.
  enum Op: Decodable {
    case model(String), view(View), flash(String), say(String, String)
    case zoom(Double, SkyPoint?), pan(Double, Double), home, focus(String?), paused(Bool)

    private enum Keys: String, CodingKey {
      case model, view, flash, say, zoom, zoomMiddle, pan, home, focus, paused
    }

    init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: Keys.self)
      if let name = try container.decodeIfPresent(String.self, forKey: .model) {
        self = .model(name)
      } else if let view = try container.decodeIfPresent(View.self, forKey: .view) {
        self = .view(view)
      } else if let id = try container.decodeIfPresent(String.self, forKey: .flash) {
        self = .flash(id)
      } else if let said = try container.decodeIfPresent([String].self, forKey: .say) {
        self = .say(said[0], said[1])
      } else if let zoom = try container.decodeIfPresent([Double].self, forKey: .zoom) {
        self = .zoom(zoom[0], SkyPoint(x: zoom[1], y: zoom[2]))
      } else if let factor = try container.decodeIfPresent(Double.self, forKey: .zoomMiddle) {
        self = .zoom(factor, nil)
      } else if let pan = try container.decodeIfPresent([Double].self, forKey: .pan) {
        self = .pan(pan[0], pan[1])
      } else if container.contains(.home) {
        self = .home
      } else if container.contains(.focus) {
        self = .focus(try container.decodeIfPresent(String.self, forKey: .focus))
      } else {
        self = .paused(try container.decode(Bool.self, forKey: .paused))
      }
    }
  }

  /// A frame after its ops, or with `count`, that many a thirtieth of a second apart.
  struct Frame: Decodable {
    let ms: Int
    let ops: [Op]?
    let sample: Bool?
    let count: Int?
    let every: Int?

    /// Each frame this stands for, and whether it is sampled.
    var frames: [(ms: Int, ops: [Op], sampled: Bool)] {
      guard let count, let every else {
        return [(ms, ops ?? [], sample == true)]
      }
      return (0..<count).map { (ms + $0 * 33, [], ($0 + 1) % every == 0) }
    }
  }

  struct Camera: Decodable {
    struct Target: Decodable {
      let x, y, scale: Double
    }

    let mode: String
    let target: Target
    let x, y, scale, centerX: Double
  }

  struct Point: Decodable {
    let x, y: Double
  }

  struct Body: Decodable {
    let id: String
    let x, y, vx, vy, presence, flash: Double
    let leaving: Bool
    let screen: Point
  }

  struct Mark: Decodable {
    let id: String
    let x, y, presence: Double
    let leaving: Bool
    let screen: Point
  }

  struct Sphere: Decodable {
    let id: String
    let x, y, radius: Double
  }

  struct Bubble: Decodable {
    let id, text: String
    let born: Double
  }

  struct Sample: Decodable {
    let ms: Int
    let camera: Camera
    let bodies: [Body]
    let marks: [Mark]
    let spheres: [Sphere]
    let bubbles: [Bubble]
    /// Specks 0, 1, 100 and 279, each as x, y, size, and alpha.
    let specks: [[Double]]
    /// Each citizen's name as drawn: the text, x, y, and the font's size.
    let names: [[JSONValue]]
  }

  struct Sequence: Decodable {
    let name: String
    let reducedMotion: Bool
    let view: View
    let frames: [Frame]
    let samples: [Sample]
  }

  struct Table: Decodable {
    let models: [String: SkyTests.WebModel]
    let sequences: [Sequence]
  }

  /// The specks a sample keeps.
  static let specks = [0, 1, 100, 279]

  @Test func theSceneMovesAsTheWebsDoes() throws {
    let table = try Fixture.sky("scene", as: Table.self)
    #expect(table.sequences.count >= 6)
    var compared = 0
    for sequence in table.sequences {
      compared += try play(sequence, models: table.models)
    }
    #expect(compared > 60)
  }

  /// Plays `sequence` through the port, checking each sample; gives how many it checked.
  private func play(_ sequence: Sequence, models: [String: SkyTests.WebModel]) throws -> Int {
    var scene = SkyScene(reducedMotion: sequence.reducedMotion)
    var view = sequence.view.viewport
    var paused = false
    var samples = sequence.samples.makeIterator()
    var checked = 0
    for frame in sequence.frames.flatMap(\.frames) {
      for op in frame.ops {
        switch op {
        case .model(let name):
          scene.setModel(try #require(models[name], "\(name)").model)
        case .view(let next): view = next.viewport
        case .flash(let id): scene.flash(id)
        case .say(let id, let text): scene.say(id, text: text)
        case .zoom(let factor, let point): scene.zoom(by: factor, at: point, in: view)
        case .pan(let dx, let dy): scene.pan(dx: dx, dy: dy)
        case .home: scene.home()
        case .focus(let anchor): scene.setFocus(anchor)
        case .paused(let value): paused = value
        }
      }
      scene.step(at: Double(frame.ms) / 1000, in: view)
      let drawn = scene.frame(in: view, ambient: true, hovered: nil, paused: paused)
      guard frame.sampled else { continue }
      let next = samples.next()
      let sample = try #require(next, "\(sequence.name): more frames sampled than kept")
      #expect(sample.ms == frame.ms)
      check(sample, scene: scene, drawn: drawn, at: "\(sequence.name) at \(frame.ms)")
      checked += 1
    }
    let left = samples.next()
    #expect(left == nil, "\(sequence.name): a sample kept that no frame took")
    return checked
  }

  private func near(_ a: Double, _ b: Double, within: Double = 1e-6) -> Bool {
    abs(a - b) <= within
  }

  private func check(_ sample: Sample, scene: SkyScene, drawn: SkyFrame, at place: String) {
    let camera = scene.camera
    #expect("\(camera.mode)" == sample.camera.mode, "\(place): the camera's mode")
    #expect(
      near(camera.camera.x, sample.camera.x) && near(camera.camera.y, sample.camera.y)
        && near(camera.camera.scale, sample.camera.scale), "\(place): the camera")
    #expect(
      near(camera.target.x, sample.camera.target.x) && near(camera.target.y, sample.camera.target.y)
        && near(camera.target.scale, sample.camera.target.scale), "\(place): the camera's target")
    #expect(near(camera.center?.x ?? 0, sample.camera.centerX), "\(place): the center")

    let bodies = scene.bodies.entries
    #expect(bodies.map(\.key) == sample.bodies.map(\.id), "\(place): the bodies")
    for (body, expected) in zip(bodies.map(\.value), sample.bodies) {
      let star = drawn.stars.first { $0.id == expected.id }
      #expect(
        near(body.x, expected.x) && near(body.y, expected.y) && near(body.vx, expected.vx)
          && near(body.vy, expected.vy) && near(body.presence, expected.presence)
          && near(body.flash, expected.flash) && body.leaving == expected.leaving,
        "\(place): \(expected.id)")
      #expect(
        star.map { near($0.center.x, expected.screen.x) && near($0.center.y, expected.screen.y) }
          == true, "\(place): \(expected.id) as drawn")
    }

    let marks = scene.marks.entries
    #expect(marks.map(\.key) == sample.marks.map(\.id), "\(place): the marks")
    for (mark, expected) in zip(marks.map(\.value), sample.marks) {
      let shown = drawn.marks.first { $0.id == expected.id }
      #expect(
        near(mark.x, expected.x) && near(mark.y, expected.y)
          && near(mark.presence, expected.presence) && mark.leaving == expected.leaving,
        "\(place): \(expected.id)")
      #expect(
        shown.map { near($0.center.x, expected.screen.x) && near($0.center.y, expected.screen.y) }
          == true, "\(place): \(expected.id) as drawn")
    }

    let spheres = scene.spheres.entries
    #expect(spheres.map(\.key) == sample.spheres.map(\.id), "\(place): the spheres")
    for (sphere, expected) in zip(spheres.map(\.value), sample.spheres) {
      #expect(
        near(sphere.x, expected.x) && near(sphere.y, expected.y)
          && near(sphere.radius, expected.radius), "\(place): \(expected.id)")
    }

    let bubbles = scene.bubbles.entries
    #expect(bubbles.map(\.key) == sample.bubbles.map(\.id), "\(place): the lines")
    for (bubble, expected) in zip(bubbles.map(\.value), sample.bubbles) {
      #expect(
        bubble.text == expected.text && near(bubble.born, expected.born),
        "\(place): \(expected.id)'s line")
    }

    for (index, expected) in zip(SkySceneTableTests.specks, sample.specks) {
      let speck = drawn.specks[index]
      #expect(
        near(speck.x, expected[0]) && near(speck.y, expected[1]) && near(speck.size, expected[2])
          // The web writes a speck's alpha to three places.
          && near(speck.alpha, expected[3], within: 0.0005 + 1e-9), "\(place): speck \(index)")
    }

    #expect(drawn.stars.count == sample.names.count, "\(place): the names")
    for (star, name) in zip(drawn.stars, sample.names) {
      let (text, x, y, size) = (name[0].string, name[1].number, name[2].number, name[3].number)
      #expect(
        text == star.name && near(star.center.x, x ?? .nan) && near(star.nameTop, y ?? .nan)
          // The web writes the font's size to one place.
          && near(star.nameSize, size ?? .nan, within: 0.05 + 1e-9), "\(place): \(star.name)'s name")
    }
  }
}

extension SkyTests.WebModel {
  /// The model as the port holds it.
  var model: SkyModel {
    SkyModel(
      anchors: anchors.map {
        SkyAnchor(
          id: $0.id, label: $0.label, kind: SkyAnchor.Kind(rawValue: $0.kind) ?? .project, x: $0.x,
          y: $0.y, radius: $0.radius)
      },
      stars: stars.map {
        SkyStar(
          id: $0.id, name: $0.name, cli: OrUnknown(rawValue: $0.cli),
          state: SkyStar.State(rawValue: $0.state) ?? .idle, resident: $0.resident,
          anchor: $0.anchor, queuedFor: $0.queuedFor, x: $0.x, y: $0.y)
      },
      tasks: tasks.map {
        SkyTaskMark(
          id: $0.id, title: $0.title, project: $0.project,
          phase: SkyTaskMark.Phase(rawValue: $0.phase) ?? .waiting, stage: $0.stage,
          holder: $0.holder, waitingFor: $0.waitingFor, linked: $0.linked, x: $0.x, y: $0.y)
      },
      radius: radius)
  }
}

extension JSONValue {
  /// The number this is, or nil for any other value.
  fileprivate var number: Double? {
    if case .number(let value) = self { value } else { nil }
  }
}
