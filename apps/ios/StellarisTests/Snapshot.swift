import SwiftUI
import UIKit
import XCTest

@testable import Stellaris

/// Renders a view in a window of a fixed size, so each view can be seen at every width the app runs
/// at and at the default and the largest type size. The pictures are kept with the test's results,
/// where CI collects them; nothing compares them with earlier ones.
@MainActor enum Snapshot {
  /// A width the app runs at, with a height to match.
  struct Size: Sendable {
    let name: String
    let size: CGSize
  }

  /// The narrowest Split View the app is laid out for, the outer display less its bar, a column of
  /// the inner display folded like a book, and the inner display in portrait and in landscape.
  static let sizes = [
    Size(name: "320", size: CGSize(width: 320, height: 678)),
    Size(name: "410", size: CGSize(width: 410, height: 678)),
    Size(name: "450", size: CGSize(width: 450, height: 669)),
    Size(name: "669", size: CGSize(width: 669, height: 951)),
    Size(name: "951", size: CGSize(width: 951, height: 669)),
  ]

  /// A type size, for SwiftUI and for the UIKit the system's lists are drawn with.
  struct TypeSize: Sendable {
    let name: String
    let dynamic: DynamicTypeSize
    let category: UIContentSizeCategory
  }

  static let typeSizes = [
    TypeSize(name: "default", dynamic: .large, category: .large),
    TypeSize(
      name: "largest", dynamic: .accessibility5, category: .accessibilityExtraExtraExtraLarge),
  ]

  /// `view` drawn in a window `size` big, with a regular width from 600 points up. iOS places its
  /// vertical bar by the display the simulator shows, the outer one, so in a window wider than that
  /// the bars fall back to the horizontal ones, as on the inner display in portrait.
  /// With `fitting`, the window then takes the height `view` lays out at, from its top, with no
  /// safe area, so a picture holds the whole of a view taller or shorter than `size`. `prepare`
  /// is given the hosting view once it is laid out, before the picture, to read or set what UIKit
  /// draws, such as a list's cells.
  static func image(
    of view: some View, size: CGSize, type: TypeSize, fitting: Bool = false,
    prepare: ((UIView) throws -> Void)? = nil
  ) async throws -> UIImage {
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
      "the test host has no window scene")
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(origin: .zero, size: size)
    let wider = size.width > scene.screen.bounds.width
    let host = UIHostingController(
      rootView: view.environment(\.dynamicTypeSize, type.dynamic).modifier(
        BarAxis(horizontal: wider)))
    host.traitOverrides.horizontalSizeClass = size.width >= 600 ? .regular : .compact
    host.traitOverrides.preferredContentSizeCategory = type.category
    if fitting {
      host.safeAreaRegions = []
    }
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.layoutIfNeeded()
    // Lists lay out their cells, and views run their tasks, while the main actor is free.
    try await Task.sleep(for: .milliseconds(600))
    host.view.layoutIfNeeded()
    if fitting {
      let tall = CGSize(width: size.width, height: .greatestFiniteMagnitude)
      let height = ceil(max(host.sizeThatFits(in: tall).height, 1))
      window.frame = CGRect(origin: .zero, size: CGSize(width: size.width, height: height))
      host.view.layoutIfNeeded()
      try await Task.sleep(for: .milliseconds(100))
      host.view.layoutIfNeeded()
    }
    if let prepare {
      try prepare(host.view)
      host.view.layoutIfNeeded()
      try await Task.sleep(for: .milliseconds(300))
      host.view.layoutIfNeeded()
    }
    return UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
  }

  /// Keeps `image` with the test's results as `<name>.png`.
  static func keep(_ image: UIImage, named name: String, in test: XCTestCase) throws {
    let png = try XCTUnwrap(image.pngData())
    let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
    attachment.name = "\(name).png"
    attachment.lifetime = .keepAlways
    test.add(attachment)
  }

  /// Draws `view` at every size and type size, and keeps each picture as `<name>-<width>-<type>`.
  static func record(_ view: some View, named name: String, in test: XCTestCase) async throws {
    for size in sizes {
      for type in typeSizes {
        // Named in the log before it is drawn, so a view whose layout never settles is found.
        print("drawing \(name)-\(size.name)-\(type.name)")
        let image = try await image(of: view, size: size.size, type: type)
        try keep(image, named: "\(name)-\(size.name)-\(type.name)", in: test)
      }
    }
  }

  /// Draws `view` at every width and type size as tall as it lays out, from its top, and keeps each
  /// picture as `<name>-<width>-<type>`.
  static func recordWhole(_ view: some View, named name: String, in test: XCTestCase) async throws
  {
    for size in sizes {
      for type in typeSizes {
        print("drawing \(name)-\(size.name)-\(type.name)")
        let image = try await image(of: view, size: size.size, type: type, fitting: true)
        try keep(image, named: "\(name)-\(size.name)-\(type.name)", in: test)
      }
    }
  }

  /// The colour of the image's pixel at `point`, in points from its top-leading corner, each
  /// channel from 0 to 255.
  static func color(in image: UIImage, at point: CGPoint) -> (red: Int, green: Int, blue: Int)? {
    guard let cgImage = image.cgImage else {
      return nil
    }
    let (x, y) = (Int(point.x * image.scale), Int(point.y * image.scale))
    guard (0..<cgImage.width).contains(x), (0..<cgImage.height).contains(y) else {
      return nil
    }
    var pixel = [UInt8](repeating: 0, count: 4)
    let drawn = pixel.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else {
        return false
      }
      // Core Graphics counts up from the bottom, so the image goes where its pixel at `point`
      // falls on the context's one.
      context.interpolationQuality = .none
      context.draw(
        cgImage,
        in: CGRect(x: -x, y: y - cgImage.height + 1, width: cgImage.width, height: cgImage.height))
      return true
    }
    return drawn ? (Int(pixel[0]), Int(pixel[1]), Int(pixel[2])) : nil
  }

  /// How many of the image's pixels are within `within` of `red`, `green`, and `blue` in each
  /// channel, each from 0 to 255.
  static func pixels(
    in image: UIImage, near color: (red: Int, green: Int, blue: Int), within: Int = 24
  ) -> Int {
    guard let (bytes, _, _) = rgba(of: image) else {
      return 0
    }
    var count = 0
    for start in stride(from: 0, to: bytes.count, by: 4) {
      let (red, green, blue) = (Int(bytes[start]), Int(bytes[start + 1]), Int(bytes[start + 2]))
      if abs(red - color.red) < within, abs(green - color.green) < within,
        abs(blue - color.blue) < within
      {
        count += 1
      }
    }
    return count
  }

  /// The colours of the image's pixels within `rect`, in points from its top-leading corner, each
  /// with its share of them, the most common first.
  static func colors(
    in image: UIImage, within rect: CGRect
  ) -> [(color: (red: Int, green: Int, blue: Int), share: Double)] {
    guard let (bytes, width, height) = rgba(of: image) else {
      return []
    }
    let scale = image.scale
    let (left, right) = (max(Int(rect.minX * scale), 0), min(Int(rect.maxX * scale), width))
    let (top, bottom) = (max(Int(rect.minY * scale), 0), min(Int(rect.maxY * scale), height))
    guard left < right, top < bottom else {
      return []
    }
    var counts: [Int: Int] = [:]
    for y in top..<bottom {
      for x in left..<right {
        let start = (y * width + x) * 4
        let key = Int(bytes[start]) << 16 | Int(bytes[start + 1]) << 8 | Int(bytes[start + 2])
        counts[key, default: 0] += 1
      }
    }
    let total = Double((right - left) * (bottom - top))
    return counts.sorted { $0.value > $1.value }.map { key, count in
      (
        color: (red: key >> 16 & 0xFF, green: key >> 8 & 0xFF, blue: key & 0xFF),
        share: Double(count) / total
      )
    }
  }

  /// The image's pixels as bytes of red, green, blue, and alpha, a row at a time from its top, with
  /// its width and height in pixels.
  nonisolated private static func rgba(
    of image: UIImage
  ) -> (bytes: [UInt8], width: Int, height: Int)? {
    guard let cgImage = image.cgImage else {
      return nil
    }
    let (width, height) = (cgImage.width, cgImage.height)
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
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    return drawn ? (bytes, width, height) : nil
  }

  /// A picture's pixels, read in points or in pixels from its top-leading corner.
  struct Bitmap {
    let width: Int
    let height: Int
    let scale: CGFloat
    private let bytes: [UInt8]

    init?(_ image: UIImage) {
      guard let (bytes, width, height) = Snapshot.rgba(of: image) else {
        return nil
      }
      self.width = width
      self.height = height
      self.scale = image.scale
      self.bytes = bytes
    }

    func pixel(_ x: Int, _ y: Int) -> (red: Int, green: Int, blue: Int) {
      let start = (y * width + x) * 4
      return (Int(bytes[start]), Int(bytes[start + 1]), Int(bytes[start + 2]))
    }

    /// The pixel at `point`, in points.
    func pixel(at point: CGPoint) -> (red: Int, green: Int, blue: Int) {
      pixel(
        min(max(Int(point.x * scale), 0), width - 1),
        min(max(Int(point.y * scale), 0), height - 1))
    }

    /// Whether the pixel at `point`, in points, is within `within` of `color` in each channel.
    func pixel(
      at point: CGPoint, isNear color: (red: Int, green: Int, blue: Int), within: Int
    ) -> Bool {
      let pixel = pixel(at: point)
      return abs(pixel.red - color.red) < within && abs(pixel.green - color.green) < within
        && abs(pixel.blue - color.blue) < within
    }
  }
}
