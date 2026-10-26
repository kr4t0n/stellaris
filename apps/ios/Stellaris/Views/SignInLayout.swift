import CoreGraphics

/// Where the sign-in form sits in its view: centred, or with a fold across the view, centred in the
/// part beside it, so the fold never runs through the form. Frames are in the view's own
/// coordinates, mirrored for a right-to-left layout, so the trailing side has the larger x.
enum SignInLayout {
  static let maxFormWidth: CGFloat = 380
  static let margin: CGFloat = 16

  /// The part of a view of `size` the form sits in. A fold that runs top to bottom, as when the
  /// phone is folded like a book, leaves the form the wider side, the trailing one when both are
  /// as wide. One that runs across, as on a table, leaves it the taller side, the upper one when
  /// both are as tall, which the keyboard doesn't cover.
  static func area(in size: CGSize, divisions: [CGRect]) -> CGRect {
    let whole = CGRect(origin: .zero, size: size)
    guard let fold = divisions.first(where: { whole.intersects($0) }) else {
      return whole
    }
    if fold.height >= fold.width {
      let leading = CGRect(x: 0, y: 0, width: max(0, fold.minX), height: size.height)
      let trailing = CGRect(
        x: fold.maxX, y: 0, width: max(0, size.width - fold.maxX), height: size.height)
      return trailing.width >= leading.width ? trailing : leading
    }
    let above = CGRect(x: 0, y: 0, width: size.width, height: max(0, fold.minY))
    let below = CGRect(
      x: 0, y: fold.maxY, width: size.width, height: max(0, size.height - fold.maxY))
    return above.height >= below.height ? above : below
  }

  /// The form's width in an area `width` wide.
  static func formWidth(in width: CGFloat) -> CGFloat {
    max(0, min(maxFormWidth, width - 2 * margin))
  }
}
