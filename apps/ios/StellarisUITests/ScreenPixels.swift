import UIKit

/// A picture of the screen, read point by point in the window's points.
struct ScreenPixels {
  /// A pixel's red, green, and blue.
  struct Colour: Equatable, CustomStringConvertible {
    let red: Int
    let green: Int
    let blue: Int

    /// Whether `other` is within `tolerance` of this colour in each channel.
    func isNear(_ other: Colour, tolerance: Int = 3) -> Bool {
      abs(red - other.red) <= tolerance && abs(green - other.green) <= tolerance
        && abs(blue - other.blue) <= tolerance
    }

    var description: String { "(\(red), \(green), \(blue))" }
  }

  private let bytes: [UInt8]
  private let width: Int
  private let height: Int
  private let scale: CGFloat

  init?(_ image: UIImage) {
    guard let picture = image.cgImage else {
      return nil
    }
    let (width, height) = (picture.width, picture.height)
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
          bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else {
        return false
      }
      context.draw(picture, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else {
      return nil
    }
    self.bytes = bytes
    self.width = width
    self.height = height
    scale = image.scale
  }

  /// The colour at `x`, `y` in points, nil outside the picture.
  func colour(x: CGFloat, y: CGFloat) -> Colour? {
    let (column, row) = (Int(x * scale), Int(y * scale))
    guard column >= 0, column < width, row >= 0, row < height else {
      return nil
    }
    return colour(column: column, row: row)
  }

  /// The first point, going down from `y` at `x` a pixel at a time, that starts a run of at least
  /// `length` points whose colours all pass `test`; one pixel when `length` is zero.
  func first(
    down x: CGFloat, from y: CGFloat, for length: CGFloat = 0, where test: (Colour) -> Bool
  ) -> CGFloat? {
    let (column, start) = (Int(x * scale), max(Int(y * scale), 0))
    guard column >= 0, column < width, start < height else {
      return nil
    }
    let needed = max(Int((length * scale).rounded(.up)), 1)
    var run = 0
    for row in start..<height {
      run = test(colour(column: column, row: row)) ? run + 1 : 0
      if run == needed {
        return CGFloat(row + 1 - needed) / scale
      }
    }
    return nil
  }

  private func colour(column: Int, row: Int) -> Colour {
    let start = (row * width + column) * 4
    return Colour(red: Int(bytes[start]), green: Int(bytes[start + 1]), blue: Int(bytes[start + 2]))
  }
}
