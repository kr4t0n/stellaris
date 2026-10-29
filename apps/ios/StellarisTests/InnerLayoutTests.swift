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

  /// The plan or the charter opens beside the thread where the chat's part leaves each a column of
  /// 320 points: with the sky above, in portrait, and not with the sky beside, in landscape, where
  /// a third column would leave the thread too narrow, nor at a compact width.
  @Test func opensThePlanBesideTheThreadOnlyWhereItFits() {
    let book = parts(landscape, divisions: [upright])
    let tabletop = parts(portrait, divisions: [across])
    #expect(!ChatView.inspectorFits(regular: true, width: book.chat.width))
    #expect(ChatView.inspectorFits(regular: true, width: tabletop.chat.width))
    #expect(!ChatView.inspectorFits(regular: false, width: 951))
    #expect(!ChatView.inspectorFits(regular: true, width: 639))
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

  /// What the layout's reader gives: its size, which ends at the keyboard while it is up, and its
  /// bottom inset, the keyboard's height then and the home indicator's otherwise.
  private func read(_ reader: CGSize, inset: CGFloat, divisions: [CGRect]) -> InnerLayout.Parts {
    InnerLayout.parts(
      reader: reader, bottomInset: inset, regular: true, divisions: divisions, cameras: [])
  }

  /// The keyboard never moves the split, with a fold reported or none, where the window's shape
  /// decides. Each pose reads only what the reader gives in it, so a turn with the keyboard up, or
  /// a view built again, lands where typing in that pose from the start does. Portrait has a
  /// keyboard 336 points tall, landscape one 339 points tall, and the home indicator takes 20.
  @Test(arguments: [true, false]) func keepsTheSplitWithTheKeyboardUp(folded: Bool) {
    let (upright, across) = folded ? ([self.upright], [self.across]) : ([], [])
    let tall = read(CGSize(width: 669, height: 615), inset: 336, divisions: across)
    #expect(tall.arrangement == .stacked)
    #expect(tall.chat == CGRect(x: 0, y: 0, width: 669, height: 615))
    #expect(tall.chatCoversSky)
    #expect(tall.sky == read(CGSize(width: 669, height: 931), inset: 20, divisions: across).sky)
    let wide = read(CGSize(width: 951, height: 330), inset: 339, divisions: upright)
    #expect(wide.arrangement == .sideBySide)
    #expect(wide.sky?.height == 669)
    #expect(wide.chat.height == 330)
    #expect(!wide.chatCoversSky)
  }

  /// Without the keyboard, the sky runs under the home indicator and the chat stops above it.
  @Test func stopsTheChatAboveTheHomeIndicator() {
    let open = read(CGSize(width: 669, height: 931), inset: 20, divisions: [across])
    #expect(open.sky == CGRect(x: 0, y: 0, width: 669, height: 486))
    #expect(open.chat == CGRect(x: 0, y: 486, width: 669, height: 445))
    #expect(!open.chatCoversSky)
    let wide = read(CGSize(width: 951, height: 649), inset: 20, divisions: [upright])
    #expect(wide.sky == CGRect(x: 0, y: 0, width: 486, height: 669))
    #expect(wide.chat == CGRect(x: 486, y: 0, width: 465, height: 649))
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
