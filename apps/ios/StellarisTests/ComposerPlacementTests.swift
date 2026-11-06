import SwiftUI
import Testing

@testable import Stellaris

/// Where the draft stands against iOS's side bar: the outer display's safe area, 34 points at the
/// foot and 85 at the trailing edge, at rest, with the software keyboard up, which the safe area's
/// foot then reads as, and with a hardware keyboard's bar, and elsewhere.
@Suite struct ComposerPlacementTests {
  private func room(bottom: CGFloat, trailing: CGFloat = 85) -> EdgeInsets {
    EdgeInsets(top: 0, leading: 0, bottom: bottom, trailing: trailing)
  }

  private func place(
    _ sideBar: HorizontalEdge? = .trailing, room: EdgeInsets?, focused: Bool = false,
    failing: Bool = false
  ) -> ComposerPlacement {
    ComposerPlacement(sideBar: sideBar, room: room, focused: focused, failing: failing)
  }

  @Test func putsTheCapsuleOnTheSideBarsFootAtRest() {
    // 10 points into the safe area: 24 above the window's foot.
    #expect(place(room: room(bottom: 34)) == ComposerPlacement(foot: -10, sendReach: 0))
    // A keyboard still going after the focus left keeps the capsule 12 points up.
    #expect(place(room: room(bottom: 304)) == ComposerPlacement(foot: 12, sendReach: 0))
  }

  @Test func putsSendInTheSideBarsColumnOnlyWhileTheKeyboardCoversItsTabs() {
    // The software keyboard, 304 points tall: Send's trailing edge 24 in from the window's.
    #expect(
      place(room: room(bottom: 304), focused: true) == ComposerPlacement(foot: 12, sendReach: -73))
    // A hardware keyboard's bar, shorter than the tabs, or none, leaves Send at the draft's edge.
    #expect(
      place(room: room(bottom: 90), focused: true) == ComposerPlacement(foot: 12, sendReach: 0))
    #expect(
      place(room: room(bottom: 34), focused: true) == ComposerPlacement(foot: 12, sendReach: 0))
    // No column wide enough for Send.
    #expect(
      place(room: room(bottom: 304, trailing: 40), focused: true)
        == ComposerPlacement(foot: 12, sendReach: 0))
  }

  @Test func putsTheCapsule24PointsUpWhereTheSafeAreaIsShorter() {
    // The inner display in landscape, whose safe area reaches 20 points up.
    #expect(place(room: room(bottom: 20)) == ComposerPlacement(foot: 4, sendReach: 0))
  }

  @Test func keepsTo12PointsWithNoSideBarBesideIt() {
    #expect(place(nil, room: room(bottom: 34)) == ComposerPlacement())
    #expect(place(.leading, room: room(bottom: 304), focused: true) == ComposerPlacement())
    // Drawn alone, with no room read.
    #expect(place(room: nil, focused: true) == ComposerPlacement())
    // A failure line under the capsule.
    #expect(place(room: room(bottom: 34), failing: true) == ComposerPlacement())
  }
}
