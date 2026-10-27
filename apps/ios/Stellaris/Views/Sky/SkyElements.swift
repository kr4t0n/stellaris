import BoardKit
import SwiftUI

/// The sky for VoiceOver, as the web's keyboard mirror is for keyboards: an element for each
/// sphere, star, and task mark, where it rests once the camera lands. Activating one opens its
/// card, and Zoom in and Zoom out zoom around it.
struct SkyElements: View {
  /// The app, handed in rather than read from the environment, which the accessibility children
  /// are built apart from.
  let app: AppModel
  let model: SkyModel
  let viewport: SkyViewport

  var body: some View {
    let sky = app.sky
    let camera = sky.camera.target
    let center = viewCenter(viewport)
    let place = { (x: Double, y: Double) in
      SkyPoint(x: center.x + (x - camera.x) * camera.scale, y: center.y + (y - camera.y) * camera.scale)
    }
    ZStack(alignment: .topLeading) {
      ForEach(model.anchors) { anchor in
        let at = place(anchor.x, anchor.y)
        let side = max(44, 2 * anchor.radius * camera.scale)
        element(.sphere(anchor.id), at: at, side: side)
          .accessibilityLabel(anchor.kind == .society ? "The society" : anchor.label)
          .accessibilityValue(SkyElements.describe(anchor, in: model))
      }
      ForEach(model.tasks) { mark in
        element(.task(mark.id), at: place(mark.x, mark.y), side: 44)
          .accessibilityLabel(markLabel(mark, place: app.store.projectName(mark.project)))
      }
      ForEach(model.stars) { star in
        element(.star(star.id), at: place(star.x, star.y), side: 44)
          .accessibilityLabel(star.name)
          .accessibilityValue(SkyElements.describe(star, in: model, said: sky.lastSaid[star.name]))
      }
    }
    .frame(width: viewport.width, height: viewport.height, alignment: .topLeading)
  }

  private func element(_ target: SkyTarget, at point: SkyPoint, side: Double) -> some View {
    let sky = app.sky
    return Color.clear
      .frame(width: side, height: side)
      .position(x: point.x, y: point.y)
      .accessibilityElement()
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier(SkyElements.identifier(target))
      .accessibilityAction { sky.card = target }
      .accessibilityAction(named: "Zoom in") { sky.zoom(by: SkyView.stepZoom, at: point) }
      .accessibilityAction(named: "Zoom out") { sky.zoom(by: 1 / SkyView.stepZoom, at: point) }
  }

  static func identifier(_ target: SkyTarget) -> String {
    switch target {
    case .star(let id): "sky-star-\(id)"
    case .task(let id): "sky-task-\(id)"
    case .sphere(let id): "sky-sphere-\(id)"
    }
  }

  /// Where a citizen is, in words, and the line it posted last while the sky was shown.
  static func describe(_ star: SkyStar, in model: SkyModel, said: String?) -> String {
    let place = { (id: String?) in
      model.anchors.first { $0.id == id }.map { $0.kind == .society ? "the society" : $0.label }
        ?? "the society"
    }
    let state =
      switch star.state {
      case .working: "In a turn at \(place(star.anchor))"
      case .queued: "Queued for \(place(star.queuedFor))"
      case .idle: "Resting"
      }
    return [state, said.map { "posted \($0)" }].compactMap { $0 }.joined(separator: ", ")
  }

  /// Who is at a sphere, and a project's tasks in play.
  static func describe(_ anchor: SkyAnchor, in model: SkyModel) -> String {
    let here = model.stars.filter { $0.anchor == anchor.id }.count
    if anchor.kind == .society {
      return here == 1 ? "1 citizen at the core" : "\(here) citizens at the core"
    }
    let tasks = model.tasks.filter { $0.project == anchor.id }.count
    return [
      here == 1 ? "1 citizen in a turn" : "\(here) citizens in a turn",
      tasks == 1 ? "1 task in play" : "\(tasks) tasks in play",
    ].joined(separator: ", ")
  }

  /// The camera, in words: the whole sky, the project it frames, or how far it is zoomed from the
  /// whole sky and where it is centred.
  static func describe(_ camera: SkyStore.Camera, model: AppModel) -> String {
    switch camera.mode {
    case .home:
      return "Whole sky"
    case .focus:
      return "Framing \(camera.focus.map { model.store.projectName($0) } ?? "a project")"
    case .manual:
      let zoom = Int((camera.target.scale / camera.homeScale * 100).rounded())
      return
        "\(zoom)%, centred on \(Int(camera.target.x.rounded())), \(Int(camera.target.y.rounded()))"
    }
  }
}
