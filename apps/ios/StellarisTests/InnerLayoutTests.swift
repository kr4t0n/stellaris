import CoreGraphics
import Testing

@testable import Stellaris

/// Where the sky and the chat go in each pose, with folds of the frames the sign-in's tests use.
@Suite struct InnerLayoutTests {
  private let landscape = CGSize(width: 951, height: 669)
  private let portrait = CGSize(width: 669, height: 951)
  /// The fold across each, with its margins.
  private let upright = CGRect(x: 465, y: 0, width: 21, height: 669)
  private let across = CGRect(x: 0, y: 465, width: 669, height: 21)

  private func parts(
    _ size: CGSize, keyboardTop: CGFloat? = nil, regular: Bool = true, divisions: [CGRect] = [],
    cameras: [CGRect] = []
  ) -> InnerLayout.Parts {
    InnerLayout.parts(
      in: size, keyboardTop: keyboardTop, regular: regular, divisions: divisions,
      cameras: cameras)
  }

  @Test func leavesTheChatAloneWhenEitherSizeClassIsCompact() {
    let outer = CGSize(width: 466, height: 678)
    let alone = parts(outer, regular: false, divisions: [upright])
    #expect(alone.arrangement == .chatAlone)
    #expect(alone.sky == nil)
    #expect(alone.chat == CGRect(origin: .zero, size: outer))
    #expect(parts(landscape, regular: false, divisions: [upright]).sky == nil)
  }

  @Test func putsTheSkyBesideTheChatAtAFoldThatRunsTopToBottom() {
    let split = parts(landscape, divisions: [upright])
    #expect(split.arrangement == .sideBySide)
    // The sky runs to the chat's edge, its camera keeping the fold's band clear.
    #expect(split.sky == CGRect(x: 0, y: 0, width: 486, height: 669))
    #expect(split.skyRoom == InnerLayout.Room(trailing: 21))
    #expect(split.chat == CGRect(x: 486, y: 0, width: 465, height: 669))
    #expect(!split.chatCoversSky)
  }

  @Test func putsTheSkyAboveTheChatAtAFoldThatRunsAcross() {
    let split = parts(portrait, divisions: [across])
    #expect(split.arrangement == .stacked)
    #expect(split.sky == CGRect(x: 0, y: 0, width: 669, height: 486))
    #expect(split.skyRoom == InnerLayout.Room(bottom: 21))
    #expect(split.chat == CGRect(x: 0, y: 486, width: 669, height: 465))
  }

  /// The fold's direction decides, not the window's shape, and the split follows it wherever it is.
  @Test func splitsWhereTheFoldIs() {
    let offCentre = CGRect(x: 520, y: 0, width: 20, height: 669)
    let split = parts(landscape, divisions: [offCentre])
    #expect(split.sky == CGRect(x: 0, y: 0, width: 540, height: 669))
    #expect(split.chat == CGRect(x: 540, y: 0, width: 411, height: 669))
    #expect(parts(landscape, divisions: [across]).arrangement == .stacked)
  }

  /// With no fold reported, as on iOS 27.0, the window splits at the middle of its longer side.
  @Test func splitsAtTheMiddleWithNoFold() {
    let wide = parts(landscape)
    #expect(wide.arrangement == .sideBySide)
    #expect(wide.sky == CGRect(x: 0, y: 0, width: 475.5, height: 669))
    #expect(wide.skyRoom == InnerLayout.Room())
    #expect(wide.chat == CGRect(x: 475.5, y: 0, width: 475.5, height: 669))
    let tall = parts(portrait)
    #expect(tall.arrangement == .stacked)
    #expect(tall.sky == CGRect(x: 0, y: 0, width: 669, height: 475.5))
    #expect(tall.chat == CGRect(x: 0, y: 475.5, width: 669, height: 475.5))
    let elsewhere = CGRect(x: 1200, y: 0, width: 20, height: 669)
    #expect(parts(landscape, divisions: [elsewhere]) == wide)
  }

  /// A keyboard that leaves the chat below the sky less than half its part grows the chat over
  /// the sky, which keeps its part; a shorter one, as a hardware keyboard's bar, only lifts the
  /// chat's foot, as it does beside the sky and with the chat alone.
  @Test func growsTheChatOverTheSkyAboveItWhileTheKeyboardIsUp() {
    let typing = parts(portrait, keyboardTop: 615, divisions: [across])
    #expect(typing.chat == CGRect(x: 0, y: 0, width: 669, height: 615))
    #expect(typing.chatCoversSky)
    #expect(typing.sky == parts(portrait, divisions: [across]).sky)
    let bar = parts(portrait, keyboardTop: 900, divisions: [across])
    #expect(bar.chat == CGRect(x: 0, y: 486, width: 669, height: 414))
    #expect(!bar.chatCoversSky)
    let beside = parts(landscape, keyboardTop: 330, divisions: [upright])
    #expect(beside.chat == CGRect(x: 486, y: 0, width: 465, height: 330))
    #expect(beside.sky == parts(landscape, divisions: [upright]).sky)
    #expect(!beside.chatCoversSky)
    let alone = parts(CGSize(width: 466, height: 678), keyboardTop: 340, regular: false)
    #expect(alone.chat == CGRect(x: 0, y: 0, width: 466, height: 340))
  }

  /// The keyboard never turns the split, even with no fold reported, where the window's shape
  /// decides: the size the split reads is the window's without the keyboard.
  @Test func keepsTheSplitWhileTheKeyboardIsUp() {
    let tall = parts(portrait, keyboardTop: 300)
    #expect(tall.arrangement == .stacked)
    #expect(tall.sky == parts(portrait).sky)
    #expect(tall.chatCoversSky)
  }

  /// A camera in the sky's part takes room from the nearer edge; one in the chat's takes none.
  @Test func keepsTheCamerasClear() {
    let corner = CGRect(x: 30, y: 0, width: 40, height: 24)
    #expect(
      parts(landscape, divisions: [upright], cameras: [corner]).skyRoom
        == InnerLayout.Room(top: 24, trailing: 21))
    let side = CGRect(x: 0, y: 300, width: 28, height: 40)
    #expect(
      parts(landscape, divisions: [upright], cameras: [side]).skyRoom
        == InnerLayout.Room(leading: 28, trailing: 21))
    let inTheChat = CGRect(x: 900, y: 0, width: 40, height: 24)
    #expect(
      parts(landscape, divisions: [upright], cameras: [inTheChat]).skyRoom
        == InnerLayout.Room(trailing: 21))
  }
}
