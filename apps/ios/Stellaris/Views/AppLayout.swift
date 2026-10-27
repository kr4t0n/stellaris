import SwiftUI

/// The signed-in app: the tabs, with the sky beside them on the inner display, split at the fold as
/// `InnerLayout` says. The tabs keep one place in the view whatever the pose, so the split never
/// builds them again, and what a view built again needs, the conversation's draft and anchor, is in
/// the model. The sky fades in with the camera it had, and folding takes it away, which stops its
/// drawing and its reads; its state stays in the model. The keyboard never moves the split, and
/// once it leaves the chat below the sky little room, the chat grows over the sky, which draws and
/// reads nothing until the keyboard goes.
struct AppLayout: View {
  @Environment(\.horizontalSizeClass) private var width
  @Environment(\.verticalSizeClass) private var height

  /// For the snapshots: a pose's reserved regions, in the window's coordinates as a fold at the
  /// middle of the display is, a keyboard's height, and a sky with a fixed clock and Reduce Motion
  /// on.
  struct Pose {
    var divisions: [CGRect]
    var cameras: [CGRect] = []
    var keyboard: CGFloat?
    var skyClock: Double?
  }

  var pose: Pose?

  var body: some View {
    GeometryReader { proxy in
      // The reader keeps to the safe area, so it ends at the keyboard while the keyboard is up, and
      // reads the keyboard's height as its bottom inset; a pose's keyboard does the same.
      let foot = proxy.size.height + proxy.safeAreaInsets.bottom
      let parts = InnerLayout.parts(
        reader: pose?.keyboard.map { CGSize(width: proxy.size.width, height: foot - $0) }
          ?? proxy.size,
        bottomInset: pose?.keyboard ?? proxy.safeAreaInsets.bottom,
        regular: regular,
        divisions: pose.map { inReader($0.divisions, proxy) } ?? regions(.division, in: proxy),
        cameras: pose.map { inReader($0.cameras, proxy) } ?? regions(.occlusion, in: proxy))
      let split = InnerSplit(parts: parts)
      split {
        if parts.sky != nil {
          SkyView(
            insets: EdgeInsets(parts.skyRoom), covered: parts.chatCoversSky,
            fixedClock: pose?.skyClock, reduceMotion: pose?.skyClock.map { _ in true }
          )
          // The keyboard comes up over the sky rather than squeezing it.
          .ignoresSafeArea(.keyboard)
          .accessibilityHidden(parts.chatCoversSky)
          .transition(.opacity.animation(.easeInOut(duration: 0.3)))
          .layoutValue(key: InnerPart.self, value: .sky)
        }
        ShellView()
          .modifier(BarAxis(horizontal: parts.arrangement == .stacked))
          .layoutValue(key: InnerPart.self, value: .chat)
      }
      .animation(.smooth(duration: 0.3), value: parts.chatCoversSky)
    }
  }

  /// A pose's frames, given in the window's coordinates, in the reader's, as iOS gives a reserved
  /// region's.
  private func inReader(_ frames: [CGRect], _ proxy: GeometryProxy) -> [CGRect] {
    let origin = proxy.frame(in: .global).origin
    return frames.map { $0.offsetBy(dx: -origin.x, dy: -origin.y) }
  }

  /// Both size classes regular: the inner display, which a debug build launched with
  /// `-StellarisInnerLayout` lays out in any window, as the UI tests drive it on the outer display,
  /// since the simulator in CI keeps the inner display closed.
  private var regular: Bool {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("-StellarisInnerLayout") {
        return true
      }
    #endif
    return width == .regular && height == .regular
  }

  private enum RegionKind {
    case division, occlusion
  }

  /// The frames of the view's reserved regions of `kind`, inactive ones included, so the split
  /// stays where it is as the phone folds and opens; only iOS 27.1 reports them.
  private func regions(_ kind: RegionKind, in proxy: GeometryProxy) -> [CGRect] {
    if #available(iOS 27.1, *) {
      let reserved: ReservedRegion.Kind = kind == .division ? .division : .occlusion
      return proxy.reservedRegions(kind: reserved, options: .includeInactive).map(\.frame)
    }
    return []
  }
}

/// Which part of the split a view is.
private enum InnerPart: LayoutValueKey {
  case sky, chat
  static let defaultValue = InnerPart.chat
}

/// Places the sky and the chat in the frames `InnerLayout` gives, the chat over the sky.
private struct InnerSplit: Layout {
  let parts: InnerLayout.Parts

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    proposal.replacingUnspecifiedDimensions()
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    for subview in subviews {
      let frame = subview[InnerPart.self] == .sky ? parts.sky ?? .zero : parts.chat
      subview.place(
        at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
        proposal: ProposedViewSize(frame.size))
    }
  }
}

/// Bars that run horizontal where `horizontal` is set: with the sky above the chat, the tab bar
/// runs along the chat's foot with a word under each icon. Elsewhere iOS decides, which on the
/// outer display is the side bar. One modifier either way, so changing it builds nothing again.
struct BarAxis: ViewModifier {
  let horizontal: Bool

  func body(content: Content) -> some View {
    if #available(iOS 27.1, *) {
      content.toolbarVerticalBehavior(horizontal ? .disabled : .automatic)
    } else {
      content
    }
  }
}

extension EdgeInsets {
  init(_ room: InnerLayout.Room) {
    self.init(top: room.top, leading: room.leading, bottom: room.bottom, trailing: room.trailing)
  }
}
