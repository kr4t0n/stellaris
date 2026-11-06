import BoardKit
import Foundation

#if canImport(ImageIO)
  import ImageIO
#endif

/// An image picked from Photos or pasted, as the app posts it: of a kind and a size the board keeps.
struct ComposerImage: Sendable, Equatable {
  let data: Data
  let type: ImageType

  /// What it is called in the post. Neither Photos nor the pasteboard gives a file's name, so it is
  /// `image` and its kind, as a browser names an image pasted into the web's composer.
  var name: String { "image.\(type.rawValue)" }

  /// Bytes that hold no picture the app can read.
  struct Unreadable: Error {}

  /// The longest side, in pixels, a picture the app draws again starts at.
  static let largestSide = 4096

  /// The picture `data` holds, without its metadata, such as where, when, and with what a photo was
  /// taken, which the board would keep for anyone who opens the image. A kind the board keeps, as
  /// the JPEG Photos gives in its most compatible encoding, goes in that kind when it fits the
  /// limit without its metadata: its pictures byte for byte, every frame and its colour profile
  /// included, and its orientation alone where that turns it (`withoutMetadata`). Anything else,
  /// such as a HEIC or TIFF pasted, a photo still past the limit without its metadata, or an image
  /// that doesn't read to its end, goes as a JPEG of the picture drawn again upright, scaled down
  /// until it fits, with nothing of the original's metadata. Nil when it holds no picture. Off the
  /// main actor, and decoded at the size it goes at, never whole: a 48-megapixel photo is about
  /// 195 MB as a bitmap, and ten may come at once.
  @concurrent nonisolated static func prepare(_ data: Data, limit: Int = imageLimitBytes) async
    -> ComposerImage?
  {
    if let type = imageType(of: data), let kept = withoutMetadata(data), kept.count <= limit {
      return ComposerImage(data: kept, type: type)
    }
    #if canImport(ImageIO)
      guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
        return nil
      }
      var side = largestSide
      while side >= 32 {
        // Upright, as the photo shows, with nothing of its metadata kept.
        let options: [CFString: Any] = [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: side,
        ]
        guard let picture = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else {
          return nil
        }
        // With what ImageIO writes beside the picture left out too.
        if let jpeg = jpeg(picture).map({ withoutMetadata($0) ?? $0 }), jpeg.count <= limit {
          return ComposerImage(data: jpeg, type: .jpeg)
        }
        side = Int(Double(max(picture.width, picture.height)) * 0.7)
      }
    #endif
    return nil
  }

  /// A small JPEG of the picture `data` holds, at most `side` pixels on its longest side, for the
  /// draft to show while the image uploads; nil when it holds no picture.
  @concurrent nonisolated static func preview(_ data: Data, side: Int = 192) async -> Data? {
    #if canImport(ImageIO)
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: side,
      ]
      guard let source = CGImageSourceCreateWithData(data as CFData, nil),
        let picture = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
      else {
        return nil
      }
      return jpeg(picture)
    #else
      return nil
    #endif
  }

  #if canImport(ImageIO)
    /// `picture` as a JPEG of the quality a photo keeps its detail at.
    nonisolated private static func jpeg(_ picture: CGImage) -> Data? {
      let data = NSMutableData()
      guard
        let destination = CGImageDestinationCreateWithData(
          data as CFMutableData, "public.jpeg" as CFString, 1, nil)
      else {
        return nil
      }
      let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.85]
      CGImageDestinationAddImage(destination, picture, options as CFDictionary)
      return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
  #endif
}
