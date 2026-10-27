import BoardKit
import Combine
import SwiftUI

/// The sky: the society's citizens as stars, its projects as spheres with their tasks orbiting
/// them, drawn edge to edge in whatever frame it is given, with the camera fitting the sky inside
/// the safe area and `insets`, the room a fold, the chat part, or the cameras take. A tap opens a
/// card at the foot of the sky, a drag pans, a pinch zooms around the fingers, and a double tap
/// zooms in; no button sits over it, and VoiceOver's camera element takes it back to the whole sky.
/// It draws at most thirty frames a second, none while it is off screen or the app is not active,
/// and with Reduce Motion or in Low Power Mode nothing drifts.
struct SkyView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

  /// Room the sky's camera leaves clear beyond the safe area.
  var insets = EdgeInsets()
  /// For the snapshots: a clock fixed at this many seconds, and Reduce Motion set either way.
  var fixedClock: Double?
  var reduceMotion: Bool?

  @State private var shown = false
  @State private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
  @State private var dragged = CGSize.zero
  @State private var pinched = 1.0

  /// How far Zoom in and Zoom out go, as the web's buttons do.
  static let stepZoom = 1.3

  var body: some View {
    let sky = model.sky
    let reduced = reduceMotion ?? systemReduceMotion
    let skyModel = sky.model(projects: model.store.projects, tasks: model.store.tasks)
    let focus = model.skyFocus
    let paused = fixedClock != nil || !shown || scenePhase != .active
    // The outer reader keeps to the safe area, so it reads the insets; the inner one runs edge to
    // edge, where a reader reads none.
    GeometryReader { safe in
      let safeArea = safe.safeAreaInsets
      GeometryReader { proxy in
        let viewport = SkyViewport(
          width: proxy.size.width, height: proxy.size.height,
          left: safeArea.leading + insets.leading,
          right: safeArea.trailing + insets.trailing,
          top: safeArea.top + insets.top,
          bottom: safeArea.bottom + insets.bottom)
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: paused)) { timeline in
          let now = fixedClock ?? timeline.date.timeIntervalSinceReferenceDate
          Canvas { context, _ in
            if sky.scene.reducedMotion != reduced {
              sky.scene.reducedMotion = reduced
            }
            if sky.scene.model != skyModel {
              sky.scene.setModel(skyModel)
            }
            sky.scene.setFocus(focus)
            sky.viewport = viewport
            sky.scene.step(at: now, in: viewport)
            let frame = sky.scene.frame(
              in: viewport, ambient: !lowPower, hovered: sky.card?.hovered,
              paused: sky.scheduler?.paused == true)
            sky.lastFrame = frame
            SkyDrawing(frame: frame).draw(in: &context)
            if sky.scene.camera.mode != sky.camera.mode
              || sky.scene.camera.target != sky.camera.target
            {
              Task { @MainActor in sky.publishCamera() }
            }
          }
        }
        .accessibilityChildren {
          SkyElements(app: model, model: skyModel, viewport: viewport)
        }
        .gesture(
          SimultaneousGesture(
            DragGesture(minimumDistance: 4)
              .onChanged { value in
                sky.pan(
                  dx: value.translation.width - dragged.width,
                  dy: value.translation.height - dragged.height)
                dragged = value.translation
              }
              .onEnded { _ in dragged = .zero },
            MagnifyGesture()
              .onChanged { value in
                let anchor = SkyPoint(
                  x: value.startAnchor.x * proxy.size.width,
                  y: value.startAnchor.y * proxy.size.height)
                sky.zoom(by: value.magnification / pinched, at: anchor)
                pinched = value.magnification
              }
              .onEnded { _ in pinched = 1 }
          )
        )
        .onTapGesture(count: 2) { point in
          sky.zoom(by: 2, at: SkyPoint(x: point.x, y: point.y))
        }
        .onTapGesture { point in
          sky.tap(at: SkyPoint(x: point.x, y: point.y))
        }
        .overlay {
          if sky.members.isEmpty {
            switch sky.state {
            case .idle, .loading:
              ProgressView()
            case .failed(let reason):
              ContentUnavailableView {
                Label(reason, systemImage: "wifi.exclamationmark")
              } actions: {
                Button("Retry") {
                  Task { await sky.load(using: model) }
                }
              }
            case .loaded:
              EmptyView()
            }
          }
        }
        .overlay(alignment: .bottom) {
          if let card = sky.card {
            // Inside the sky's part: the card scrolls in what room it leaves.
            VStack(spacing: 0) {
              Spacer(minLength: viewport.top + 12)
              SkyCard(target: card, model: skyModel)
            }
            .padding(.bottom, viewport.bottom + 12)
            .padding(.leading, viewport.left + 12)
            .padding(.trailing, viewport.right + 12)
          }
        }
      }
      .ignoresSafeArea()
    }
    .background(Color(sky: SkyPalette.surface0).ignoresSafeArea())
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("sky")
    .onAppear { shown = true }
    .onDisappear { shown = false }
    .task(id: scenePhase == .active && fixedClock == nil) {
      guard scenePhase == .active, fixedClock == nil else {
        return
      }
      await sky.run(using: model)
    }
    .onReceive(
      NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
        .receive(on: DispatchQueue.main)
    ) { _ in
      lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    }
  }
}

extension Color {
  init(sky color: SkyColor, opacity: Double = 1) {
    self.init(.sRGB, red: color.red, green: color.green, blue: color.blue, opacity: opacity)
  }
}
