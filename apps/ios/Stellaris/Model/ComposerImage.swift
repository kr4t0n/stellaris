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

  /// `data` as it is when the board keeps its kind and its size, as for the JPEG Photos gives in its
  /// most compatible encoding; otherwise the picture it holds, such as a HEIC or TIFF pasted, or a
  /// photo past the limit, as a JPEG, scaled down until it fits. Nil when it holds no picture. Off
  /// the main actor, and decoded at the size it goes at, never whole: a 48-megapixel photo is about
  /// 195 MB as a bitmap, and ten may come at once.
  @concurrent nonisolated static func prepare(_ data: Data, limit: Int = imageLimitBytes) async
    -> ComposerImage?
  {
    if let type = imageType(of: data), data.count <= limit {
      return ComposerImage(data: data, type: type)
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
        if let jpeg = jpeg(picture), jpeg.count <= limit {
          return ComposerImage(data: jpeg, type: .jpeg)
        }
        side = Int(Double(max(picture.width, picture.height)) * 0.7)
      }
    #endif
    return nil
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
