import SwiftUI

/// The signed-in app: the tabs, with the sky beside them on the inner display, split at the fold as
/// `InnerLayout` says. The tabs keep one place in the view whatever the pose, so the split never
/// builds them again, and what a view built again needs, the conversation's draft and anchor, is in
/// the model. The sky fades in with the camera it had, and folding takes it away, which stops its
/// drawing and its reads; its state stays in the model. The split keeps to the window as it is
/// without the keyboard, and once the keyboard leaves the chat below the sky little room, the chat
/// grows over the sky, which draws nothing until the keyboard goes.
struct AppLayout: View {
  @Environment(\.horizontalSizeClass) private var width
  @Environment(\.verticalSizeClass) private var height

  /// For the snapshots: a pose's reserved regions and keyboard, and a sky with a fixed clock and
  /// Reduce Motion on.
  struct Pose {
    var divisions: [CGRect]
    var cameras: [CGRect] = []
    var keyboardTop: CGFloat?
    var skyClock: Double?
  }

  var pose: Pose?

  /// The window's size without the keyboard.
  @State private var unkeyed: CGSize?

  var body: some View {
    GeometryReader { proxy in
      // The reader ends at the keyboard while it is up; the split keeps to the size without it.
      let size = unkeyed.flatMap { full in
        full.width == proxy.size.width && full.height > proxy.size.height ? full : nil
      }
      let parts = InnerLayout.parts(
        in: size ?? proxy.size,
        keyboardTop: pose?.keyboardTop ?? size.map { _ in proxy.size.height },
        regular: regular,
        divisions: pose?.divisions ?? regions(.division, in: proxy),
        cameras: pose?.cameras ?? regions(.occlusion, in: proxy))
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
          .transition(.opacity)
          .layoutValue(key: InnerPart.self, value: .sky)
        }
        ShellView()
          .modifier(BarAxis(horizontal: parts.arrangement == .stacked))
          .layoutValue(key: InnerPart.self, value: .chat)
      }
      .animation(.easeInOut(duration: 0.3), value: parts.sky != nil)
      .animation(.smooth(duration: 0.3), value: parts.chatCoversSky)
    }
    .background {
      Color.clear
        .ignoresSafeArea(.keyboard)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { unkeyed = $0 }
    }
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
