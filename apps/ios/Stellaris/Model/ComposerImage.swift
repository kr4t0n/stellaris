import BoardKit
import Foundation

#if canImport(UIKit)
  import UIKit
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

  /// `data` as it is when the board keeps its kind and its size; otherwise the picture it holds,
  /// such as a HEIC photo or one past the limit, as a JPEG, scaled down until it fits. Nil when it
  /// holds no picture. Off the main actor: a large photo takes a while to draw again.
  @concurrent nonisolated static func prepare(_ data: Data, limit: Int = imageLimitBytes) async
    -> ComposerImage?
  {
    if let type = imageType(of: data), data.count <= limit {
      return ComposerImage(data: data, type: type)
    }
    #if canImport(UIKit)
      guard let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else {
        return nil
      }
      let pixels = CGSize(
        width: image.size.width * image.scale, height: image.size.height * image.scale)
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      var factor: CGFloat = 1
      while factor > 0.02 {
        let size = CGSize(
          width: max(1, (pixels.width * factor).rounded()),
          height: max(1, (pixels.height * factor).rounded()))
        // Drawn upright, as the photo shows, with nothing of its metadata kept.
        let jpeg = UIGraphicsImageRenderer(size: size, format: format)
          .jpegData(withCompressionQuality: 0.85) { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
          }
        if jpeg.count <= limit {
          return ComposerImage(data: jpeg, type: .jpeg)
        }
        factor *= 0.7
      }
    #endif
    return nil
  }
}
