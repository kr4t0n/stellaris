// Images the user posts from the composer, as the board takes them from `POST /api/images`: a
// port of `imageTypeOf` and `IMAGE_LIMIT_BYTES` in `packages/shared/src/images.ts`.

import Foundation

/// The kinds of image the board keeps, told by their first bytes, never by a name. SVG is none: it
/// is a document that can carry script.
public enum ImageType: String, Sendable, Hashable, CaseIterable {
  case png, jpeg, gif, webp

  /// The media type the board serves the kind as, and the app posts it as.
  public var mediaType: String { "image/\(rawValue)" }
}

/// The largest image the board keeps.
public let imageLimitBytes = 8 * 1024 * 1024

/// The kind of image `data` holds by its header, as the board tells it, or nil for anything else.
public func imageType(of data: Data) -> ImageType? {
  let head = Array(data.prefix(12))
  func starts(_ prefix: [UInt8], at offset: Int = 0) -> Bool {
    head.count >= offset + prefix.count && Array(head[offset..<offset + prefix.count]) == prefix
  }
  if starts([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
    return .png
  }
  if starts([0xFF, 0xD8, 0xFF]) {
    return .jpeg
  }
  if starts(Array("GIF87a".utf8)) || starts(Array("GIF89a".utf8)) {
    return .gif
  }
  if starts(Array("RIFF".utf8)) && starts(Array("WEBP".utf8), at: 8) {
    return .webp
  }
  return nil
}

/// What the board answers for an image it kept: its id and the markdown that shows it in a post.
public struct UploadedImage: Sendable, Hashable, Codable {
  public let id: String
  public let type: OrUnknown<ImageType>
  public let size: Int
  public let markdown: String
}
