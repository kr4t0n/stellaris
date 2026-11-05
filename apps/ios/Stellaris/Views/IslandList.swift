import SwiftUI
import UIKit

/// Board's, Needs you's, and Settings' lists on the conversation's island gray, as the web's board
/// views sit on the island the conversation does, in place of the system's black.
private struct IslandList: ViewModifier {
  func body(content: Content) -> some View {
    content
      .scrollContentBackground(.hidden)
      .background(MessageColor.island)
  }
}

extension View {
  /// The list on the conversation's island gray.
  func islandList() -> some View {
    modifier(IslandList())
  }

  /// A row of a list on the island gray: on `surface-2` at 50% over it, the web's row under the
  /// pointer and its composer's box, so a grouped list's sections read apart from the gray around
  /// them; or, in a plain list, on the island itself, as the web's rows are. Pressed or selected,
  /// it takes the system's highlight (`RowGround`).
  func islandRow(plain: Bool = false) -> some View {
    listRowBackground(
      RowGround(rest: plain ? .clear : UIColor(MessageColor.surface2.opacity(0.5))))
  }
}

/// A row's ground: `rest`, or the system's highlight, `systemGray4`, while the list's cell it is
/// drawn in is highlighted, as a touch leaves it, or selected, as opening a row does. A row
/// background of the app's own hides the one the list draws for those states, so this follows the
/// cell's own.
private struct RowGround: UIViewRepresentable {
  let rest: UIColor

  func makeUIView(context: Context) -> RowGroundView {
    RowGroundView(rest: rest)
  }

  func updateUIView(_ view: RowGroundView, context: Context) {
    view.rest = rest
  }
}

private final class RowGroundView: UIView {
  var rest: UIColor {
    didSet { follow() }
  }
  /// The list's cell the ground is drawn in, once it is in a window.
  private weak var cell: UICollectionViewCell?
  private var observations: [NSKeyValueObservation] = []

  init(rest: UIColor) {
    self.rest = rest
    super.init(frame: .zero)
    backgroundColor = rest
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    var view = superview
    while let next = view, !(next is UICollectionViewCell) {
      view = next.superview
    }
    let found = view as? UICollectionViewCell
    if found !== cell {
      cell = found
      observations = []
      if let found {
        // UIKit sets a cell's state on the main thread, where the observation tells of it.
        let changed: @Sendable (UICollectionViewCell, NSKeyValueObservedChange<Bool>) -> Void = {
          [weak self] _, _ in
          MainActor.assumeIsolated {
            guard let self else {
              return
            }
            self.follow()
          }
        }
        observations = [
          found.observe(\.isHighlighted, changeHandler: changed),
          found.observe(\.isSelected, changeHandler: changed),
        ]
      }
    }
    follow()
  }

  private func follow() {
    let marked = cell.map { $0.isHighlighted || $0.isSelected } ?? false
    let ground = marked ? UIColor.systemGray4 : rest
    guard backgroundColor != ground else {
      return
    }
    // The highlight comes on at once; going back to rest, as a press ends or a row is deselected,
    // fades, as the system's own rows do.
    if marked || window == nil {
      backgroundColor = ground
    } else {
      UIView.animate(withDuration: 0.25) {
        self.backgroundColor = ground
      }
    }
  }
}
