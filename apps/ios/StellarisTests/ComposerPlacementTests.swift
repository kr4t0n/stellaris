import SwiftUI
import Testing

@testable import Stellaris

/// Where the draft stands against iOS's side bar: the outer display's safe area, 34 points at the
/// foot and 85 at the trailing edge, with the keyboard down, the software keyboard up, and a
/// hardware keyboard's bar, and elsewhere.
@Suite struct ComposerPlacementTests {
  private let outer = EdgeInsets(top: 0, leading: 0, bottom: 34, trailing: 85)

  private func place(
    _ sideBar: HorizontalEdge? = .trailing, room: EdgeInsets?, keyboard: CGFloat,
    focused: Bool = false, failing: Bool = false
  ) -> ComposerPlacement {
    ComposerPlacement(
      sideBar: sideBar, room: room, keyboard: keyboard, focused: focused, failing: failing)
  }

  @Test func putsTheCapsuleOnTheSideBarsFootWithTheKeyboardDown() {
    // 10 points into the safe area: 24 above the window's foot.
    #expect(place(room: outer, keyboard: 34) == ComposerPlacement(foot: -10, sendReach: 0))
    // Focused with a hardware keyboard and no bar of its own, as at rest.
    #expect(
      place(room: outer, keyboard: 34, focused: true) == ComposerPlacement(foot: -10, sendReach: 0))
  }

  @Test func putsSendInTheSideBarsColumnOnlyWhileTheKeyboardCoversItsTabs() {
    // The software keyboard, 304 points tall: Send's trailing edge 24 in from the window's.
    #expect(
      place(room: outer, keyboard: 304, focused: true)
        == ComposerPlacement(foot: 12, sendReach: -73))
    // A hardware keyboard's bar, shorter than the tabs, leaves Send at the draft's edge.
    #expect(
      place(room: outer, keyboard: 90, focused: true) == ComposerPlacement(foot: 12, sendReach: 0))
    // Not focused, as while the keyboard goes: no Send, and the capsule keeps to the draft's edge.
    #expect(place(room: outer, keyboard: 304) == ComposerPlacement(foot: 12, sendReach: 0))
    // No column wide enough for Send.
    let narrow = EdgeInsets(top: 0, leading: 0, bottom: 34, trailing: 40)
    #expect(
      place(room: narrow, keyboard: 304, focused: true) == ComposerPlacement(foot: 12, sendReach: 0)
    )
  }

  @Test func putsTheCapsule24PointsUpWhereTheSafeAreaIsShorter() {
    // The inner display in landscape, whose safe area reaches 20 points up.
    let landscape = EdgeInsets(top: 0, leading: 0, bottom: 20, trailing: 85)
    #expect(place(room: landscape, keyboard: 20) == ComposerPlacement(foot: 4, sendReach: 0))
  }

  @Test func keepsTo12PointsWithNoSideBarBesideIt() {
    #expect(place(nil, room: outer, keyboard: 34) == ComposerPlacement())
    #expect(place(.leading, room: outer, keyboard: 304, focused: true) == ComposerPlacement())
    // Drawn alone, with no room read.
    #expect(place(room: nil, keyboard: 0, focused: true) == ComposerPlacement())
    // A failure line under the capsule.
    #expect(
      place(room: outer, keyboard: 34, failing: true) == ComposerPlacement(foot: 12, sendReach: 0))
  }
}
