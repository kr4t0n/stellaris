import CoreGraphics

/// Where the sky and the chat go in the app's window. Frames are in the coordinates of the view
/// the layout fills, which keeps to the window's safe area, as the frames of the reserved regions
/// it reads are: (0, 0) is that view's top-leading corner, below the status bar, and right to
/// left the frames are mirrored, so the leading side has the smaller x.
///
/// With a compact width or height, the outer display and Split View, the chat has the whole
/// window and there is no sky. With both regular, the inner display, the window splits at its
/// fold: the sky on the leading side and the chat on the trailing one when the fold runs top to
/// bottom, and the sky above the chat when it runs across. The fold is the division iOS reports,
/// active or not, so a partial fold moves nothing; with none reported, the middle of the window's
/// longer side. The keyboard never moves the split: only the chat's foot follows it, and the chat
/// grows over a sky above it once the keyboard leaves it less than half its part.
enum InnerLayout {
  /// Room at each edge of a part, in points.
  struct Room: Equatable, Sendable {
    var top: CGFloat = 0
    var leading: CGFloat = 0
    var bottom: CGFloat = 0
    var trailing: CGFloat = 0
  }

  enum Arrangement: Equatable, Sendable {
    case chatAlone, sideBySide, stacked
  }

  struct Parts: Equatable, Sendable {
    var arrangement: Arrangement
    /// The sky's part, which runs to the chat's edge; nil when the chat is alone.
    var sky: CGRect?
    /// What the sky's camera keeps clear in its part: the fold's band and the cameras.
    var skyRoom = Room()
    var chat: CGRect
    /// Whether the chat lies over the sky, as it does while the keyboard is up with the sky above
    /// it. The sky keeps its part underneath and draws nothing.
    var chatCoversSky = false
  }

  /// The parts of a view `reader` big whose safe area leaves `bottomInset` below it: the keyboard's
  /// height while it is up, and the home indicator's otherwise. The view ends at the keyboard and
  /// the inset grows by as much, so the two reach the window's foot whatever the keyboard does, and
  /// the split reads that height, from nothing seen before; the chat's foot is the view's.
  static func parts(
    reader: CGSize, bottomInset: CGFloat, regular: Bool, divisions: [CGRect], cameras: [CGRect]
  ) -> Parts {
    parts(
      in: CGSize(width: reader.width, height: reader.height + max(0, bottomInset)),
      keyboardTop: reader.height, regular: regular, divisions: divisions, cameras: cameras)
  }

  /// The parts of a view of `size`, as it is to the window's foot. `keyboardTop` is how far down
  /// it the chat may reach, where the keyboard or the home indicator starts; `regular` is whether
  /// both size classes are; and `divisions` and `cameras` are the frames of the reserved regions
  /// iOS reports, inactive ones included.
  static func parts(
    in size: CGSize, keyboardTop: CGFloat? = nil, regular: Bool, divisions: [CGRect],
    cameras: [CGRect]
  ) -> Parts {
    let whole = CGRect(origin: .zero, size: size)
    let foot = min(keyboardTop ?? size.height, size.height)
    guard regular, size.width > 0, size.height > 0 else {
      return Parts(
        arrangement: .chatAlone, chat: CGRect(x: 0, y: 0, width: size.width, height: foot))
    }
    let found = divisions.first { whole.intersects($0) }
    let sideBySide = found.map { $0.height >= $0.width } ?? (size.width >= size.height)
    var parts: Parts
    if sideBySide {
      let fold = found ?? CGRect(x: size.width / 2, y: 0, width: 0, height: size.height)
      let edge = min(max(fold.maxX, 0), size.width)
      let sky = CGRect(x: 0, y: 0, width: edge, height: size.height)
      parts = Parts(
        arrangement: .sideBySide, sky: sky,
        skyRoom: Room(trailing: max(0, edge - max(fold.minX, 0))),
        chat: CGRect(x: edge, y: 0, width: size.width - edge, height: foot))
    } else {
      let fold = found ?? CGRect(x: 0, y: size.height / 2, width: size.width, height: 0)
      let edge = min(max(fold.maxY, 0), size.height)
      let sky = CGRect(x: 0, y: 0, width: size.width, height: edge)
      parts = Parts(
        arrangement: .stacked, sky: sky,
        skyRoom: Room(bottom: max(0, edge - max(fold.minY, 0))),
        chat: CGRect(x: 0, y: edge, width: size.width, height: foot - edge))
      if foot - edge < (size.height - edge) / 2 {
        // The keyboard leaves the chat below the fold little room, so it grows over the sky.
        parts.chat = CGRect(x: 0, y: 0, width: size.width, height: foot)
        parts.chatCoversSky = true
      }
    }
    if let sky = parts.sky {
      parts.skyRoom = clearing(cameras, in: sky, beyond: parts.skyRoom)
    }
    return parts
  }

  /// `room` grown to keep each camera that reaches into `part` clear, from whichever of the part's
  /// edges clears it with the least room.
  static func clearing(_ cameras: [CGRect], in part: CGRect, beyond room: Room) -> Room {
    var room = room
    for camera in cameras where camera.intersects(part) {
      let top = camera.maxY - part.minY
      let leading = camera.maxX - part.minX
      let bottom = part.maxY - camera.minY
      let trailing = part.maxX - camera.minX
      let least = min(top, leading, bottom, trailing)
      if least == top {
        room.top = max(room.top, top)
      } else if least == leading {
        room.leading = max(room.leading, leading)
      } else if least == bottom {
        room.bottom = max(room.bottom, bottom)
      } else {
        room.trailing = max(room.trailing, trailing)
      }
    }
    return room
  }
}
