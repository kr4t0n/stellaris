import BoardKit
import Foundation
import Testing

#if canImport(UIKit)
  import ImageIO
  import UIKit
#endif

@testable import Stellaris

/// What `ComposerImage.prepare` sends of a JPEG, PNG, GIF, or WebP the board keeps: the picture,
/// every frame of it as it was drawn, and nothing of what the image says beside it but the
/// orientation that turns it. Each image is made here, with a made-up camera and a made-up place
/// in the South Atlantic, as a camera, an editor, or an encoder leaves one, and read back with
/// ImageIO, as the app reads a picture.
@MainActor @Suite struct PhotoMetadataTests {
  /// Words the images below hold beside their pictures, none of which may reach the board.
  private let madeUp = ["Example", "Nowhere", "made up", "XMP DataXMP", "ns.adobe.com/xap"]

  private let xmp = Array(
    (#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF "#
      + #"xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description "#
      + #"rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreatorTool>Example "#
      + #"Tool</xmp:CreatorTool></rdf:Description></rdf:RDF></x:xmpmeta>"#).utf8)

  /// A 1-pixel PNG and an 8-pixel JPEG that hold nothing but their pictures.
  private let plainPNG = Data(
    base64Encoded: [
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUzZswgIiSpAAAACklEQVQI12NgAAAAAgAB",
      "4iG8MwAAAABJRU5ErkJggg==",
    ].joined())!
  private let plainJPEG = Data(
    base64Encoded: [
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4R",
      "DgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU",
      "FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAA",
      "B//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAA",
      "AAD/2gAMAwEAAhEDEQA/AC9UAkf/2Q==",
    ].joined())!

  @Test func sendsAnImageThatHoldsNoMetadataAsItIs() async {
    #expect(await ComposerImage.prepare(plainPNG) == ComposerImage(data: plainPNG, type: .png))
    #expect(await ComposerImage.prepare(plainJPEG) == ComposerImage(data: plainJPEG, type: .jpeg))
  }

  #if canImport(UIKit)
    /// Stripes `width` by `height` pixels with a mark in one corner, stored in Display P3 as an
    /// iPhone's camera stores a photo, or in sRGB.
    private func stripes(width: Int, height: Int, wide: Bool = true, hue: CGFloat = 0) throws
      -> CGImage
    {
      let space = try #require(
        CGColorSpace(name: wide ? CGColorSpace.displayP3 : CGColorSpace.sRGB))
      let context = try #require(
        CGContext(
          data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      for x in stride(from: 0, to: width, by: 4) {
        let shade = CGFloat(x) / CGFloat(width)
        context.setFillColor(red: hue, green: shade, blue: 1 - shade, alpha: 1)
        context.fill(CGRect(x: x, y: 0, width: 4, height: height))
      }
      context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
      context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
      return try #require(context.makeImage())
    }

    /// `pictures` as ImageIO writes an image of `type`, with `file`'s properties and each
    /// picture's.
    private func encoded(
      _ pictures: [CGImage], as type: String, file: [CFString: Any] = [:],
      each: [CFString: Any] = [:]
    ) throws -> Data {
      let data = NSMutableData()
      let destination = try #require(
        CGImageDestinationCreateWithData(
          data as CFMutableData, type as CFString, pictures.count, nil))
      CGImageDestinationSetProperties(destination, file as CFDictionary)
      for picture in pictures {
        CGImageDestinationAddImage(destination, picture, each as CFDictionary)
      }
      try #require(CGImageDestinationFinalize(destination))
      return data as Data
    }

    private func bigEndian(_ value: Int, size: Int) -> [UInt8] {
      (0..<size).reversed().map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
    }

    private func littleEndian(_ value: Int, size: Int) -> [UInt8] {
      (0..<size).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
    }

    /// A photo as a camera writes it, turned by its orientation tag, with the camera's Exif, TIFF,
    /// GPS, and IPTC as ImageIO writes them, then XMP and a comment after them, as an editor adds.
    private func cameraJPEG(width: Int = 60, height: Int = 40) throws -> Data {
      let photo = try encoded(
        [stripes(width: width, height: height)], as: "public.jpeg",
        each: [
          kCGImageDestinationLossyCompressionQuality: 0.9,
          kCGImagePropertyOrientation: 6,
          kCGImagePropertyTIFFDictionary: [
            kCGImagePropertyTIFFMake: "Example", kCGImagePropertyTIFFModel: "Example One",
            kCGImagePropertyTIFFOrientation: 6,
          ] as [CFString: Any],
          kCGImagePropertyExifDictionary: [
            kCGImagePropertyExifDateTimeOriginal: "2001:02:03 04:05:06",
            kCGImagePropertyExifLensModel: "Example Lens",
            kCGImagePropertyExifUserComment: "made up",
          ],
          kCGImagePropertyGPSDictionary: [
            kCGImagePropertyGPSLatitude: 12.334, kCGImagePropertyGPSLatitudeRef: "S",
            kCGImagePropertyGPSLongitude: 23.456, kCGImagePropertyGPSLongitudeRef: "W",
            kCGImagePropertyGPSAltitude: 10,
          ] as [CFString: Any],
          kCGImagePropertyIPTCDictionary: [
            kCGImagePropertyIPTCCity: "Nowhere", kCGImagePropertyIPTCKeywords: ["made up"],
          ] as [CFString: Any],
        ])
      func segment(_ marker: UInt8, _ payload: [UInt8]) -> [UInt8] {
        [0xFF, marker] + bigEndian(payload.count + 2, size: 2) + payload
      }
      var bytes = [UInt8](photo)
      var at = 2
      while at + 4 <= bytes.count, bytes[at] == 0xFF, (0xE0...0xEF).contains(bytes[at + 1]) {
        at += 2 + Int(bytes[at + 2]) << 8 + Int(bytes[at + 3])
      }
      bytes.insert(
        contentsOf: segment(0xE1, Array("http://ns.adobe.com/xap/1.0/\0".utf8) + xmp)
          + segment(0xFE, Array("made up".utf8)), at: at)
      return Data(bytes)
    }

    /// A PNG as an editor writes one, with its text, XMP, and the place ImageIO writes after its
    /// header.
    private func editedPNG() throws -> Data {
      let png = try encoded(
        [stripes(width: 30, height: 20)], as: "public.png",
        each: [
          kCGImagePropertyPNGDictionary: [
            kCGImagePropertyPNGDescription: "made up", kCGImagePropertyPNGAuthor: "Example",
          ],
          kCGImagePropertyGPSDictionary: [
            kCGImagePropertyGPSLatitude: 12.334, kCGImagePropertyGPSLatitudeRef: "S",
            kCGImagePropertyGPSLongitude: 23.456, kCGImagePropertyGPSLongitudeRef: "W",
          ] as [CFString: Any],
        ])
      func chunk(_ type: String, _ data: [UInt8]) -> [UInt8] {
        let body = Array(type.utf8) + data
        var crc = ~UInt32(0)
        for byte in body {
          crc ^= UInt32(byte)
          for _ in 0..<8 {
            crc = crc & 1 == 1 ? 0xEDB8_8320 ^ (crc >> 1) : crc >> 1
          }
        }
        return bigEndian(data.count, size: 4) + body + bigEndian(Int(~crc), size: 4)
      }
      var bytes = [UInt8](png)
      // After the signature and the header's 13 bytes, length, type, and CRC.
      bytes.insert(
        contentsOf: chunk("tEXt", Array("Comment\0made up".utf8))
          + chunk("iTXt", Array("XML:com.adobe.xmp\0\0\0\0\0".utf8) + xmp), at: 8 + 25)
      return Data(bytes)
    }

    /// An animated GIF of two frames as ImageIO writes one, with a comment and XMP after its
    /// colour table.
    private func commentedGIF() throws -> Data {
      let gif = try encoded(
        [
          stripes(width: 16, height: 8, wide: false, hue: 1),
          stripes(width: 16, height: 8, wide: false, hue: 0),
        ], as: "com.compuserve.gif",
        file: [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]],
        each: [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.1]])
      func subBlocks(_ data: [UInt8]) -> [UInt8] {
        stride(from: 0, to: data.count, by: 255).flatMap { start in
          let block = data[start..<min(start + 255, data.count)]
          return [UInt8(block.count)] + block
        } + [0]
      }
      var bytes = [UInt8](gif)
      let table = bytes[10] & 0x80 == 0 ? 0 : 3 << (Int(bytes[10] & 0x07) + 1)
      bytes.insert(
        contentsOf: [0x21, 0xFE] + subBlocks(Array("made up".utf8)) + [0x21, 0xFF, 11]
          + Array("XMP DataXMP".utf8) + subBlocks(xmp), at: 13 + table)
      return Data(bytes)
    }

    /// An animated WebP of a red frame and a blue one, 2 pixels square, losslessly encoded, with
    /// Exif naming a camera, XMP, and a chunk of no kind WebP knows, as its flags say.
    private func animatedWebP() -> Data {
      func chunk(_ type: String, _ data: [UInt8]) -> [UInt8] {
        Array(type.utf8) + littleEndian(data.count, size: 4) + data
          + (data.count % 2 == 1 ? [0] : [])
      }
      /// A frame at 0, 0, 2 by 2 pixels, shown for 100 ms, of one colour.
      func frame(_ colour: [UInt8]) -> [UInt8] {
        let placement: [UInt8] = [0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 100, 0, 0, 0]
        let lossless: [UInt8] =
          [0x2F, 0x01, 0x40, 0, 0, 0x07, 0x10] + colour + [0x22, 0xA2, 0xFF, 0x01]
        return chunk("ANMF", placement + chunk("VP8L", lossless))
      }
      let camera: [UInt8] =
        [0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x0F, 0, 2, 0, 0, 0, 8, 0, 0, 0, 26, 0, 0, 0, 0]
        + Array("Example\0".utf8)
      let chunks =
        chunk("VP8X", [0x0E, 0, 0, 0, 1, 0, 0, 1, 0, 0]) + chunk("ANIM", [255, 255, 255, 255, 0, 0])
        + frame([0xFD, 0x8F, 0xFE, 0x07]) + frame([0xD1, 0xFF, 0xFE, 0x07])
        + chunk("EXIF", camera) + chunk("XMP ", xmp) + chunk("NOTE", Array("Nowhere".utf8))
      return Data(
        Array("RIFF".utf8) + littleEndian(chunks.count + 4, size: 4) + Array("WEBP".utf8) + chunks)
    }

    /// The picture at `index` in `source`, as it is stored, drawn in sRGB.
    private func pixels(_ source: CGImageSource, _ index: Int) throws -> [UInt8] {
      let picture = try #require(CGImageSourceCreateImageAtIndex(source, index, nil))
      let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
      let context = try #require(
        CGContext(
          data: nil, width: picture.width, height: picture.height, bitsPerComponent: 8,
          bytesPerRow: picture.width * 4, space: space,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      context.draw(picture, in: CGRect(x: 0, y: 0, width: picture.width, height: picture.height))
      let data = try #require(context.data)
      return Array(
        UnsafeRawBufferPointer(start: data, count: picture.height * context.bytesPerRow))
    }

    /// The dictionaries ImageIO reads an image's metadata into, none of which may be left.
    private let metadataDictionaries: [CFString] = [
      kCGImagePropertyExifDictionary, kCGImagePropertyExifAuxDictionary,
      kCGImagePropertyGPSDictionary, kCGImagePropertyIPTCDictionary, kCGImageProperty8BIMDictionary,
      kCGImagePropertyDNGDictionary, kCGImagePropertyCIFFDictionary,
      kCGImagePropertyMakerAppleDictionary, kCGImagePropertyMakerCanonDictionary,
      kCGImagePropertyMakerNikonDictionary, kCGImagePropertyMakerMinoltaDictionary,
      kCGImagePropertyMakerFujiDictionary, kCGImagePropertyMakerOlympusDictionary,
      kCGImagePropertyMakerPentaxDictionary,
    ]

    /// A PNG's text, which ImageIO reads into its PNG dictionary.
    private let pngText: [CFString] = [
      kCGImagePropertyPNGAuthor, kCGImagePropertyPNGComment, kCGImagePropertyPNGCopyright,
      kCGImagePropertyPNGCreationTime, kCGImagePropertyPNGDescription,
      kCGImagePropertyPNGDisclaimer, kCGImagePropertyPNGModificationTime,
      kCGImagePropertyPNGSoftware, kCGImagePropertyPNGSource, kCGImagePropertyPNGTitle,
      kCGImagePropertyPNGWarning,
    ]

    /// What ImageIO reads of the picture at `index` in `source` beside the picture itself: each
    /// metadata dictionary's keys, the TIFF dictionary's, the PNG's text, and every XMP tag.
    private func metadata(_ source: CGImageSource, _ index: Int) -> [String] {
      let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [String: Any]
      var found: [String] = []
      for name in (metadataDictionaries + [kCGImagePropertyTIFFDictionary]).map({ $0 as String }) {
        if let dictionary = properties?[name] as? [String: Any] {
          found += dictionary.keys.map { "\(name).\($0)" }.sorted()
        }
      }
      let png = kCGImagePropertyPNGDictionary as String
      if let text = properties?[png] as? [String: Any] {
        found += pngText.map { $0 as String }.filter { text[$0] != nil }.map { "\(png).\($0)" }
      }
      let tags =
        CGImageSourceCopyMetadataAtIndex(source, index, nil).flatMap(CGImageMetadataCopyTags)
        as? [CGImageMetadataTag] ?? []
      for tag in tags {
        let prefix = CGImageMetadataTagCopyPrefix(tag) as String? ?? "?"
        let name = CGImageMetadataTagCopyName(tag) as String? ?? "?"
        found.append("\(prefix):\(name)")
      }
      return found
    }

    /// Checks that `prepared` holds `original`'s pictures in its kind, frame by frame as they were
    /// stored, with its orientation and colours, and nothing else that it says.
    private func expectPictures(
      of original: Data, in prepared: ComposerImage?, type: ImageType, frames: Int
    ) throws {
      let prepared = try #require(prepared)
      #expect(prepared.type == type && imageType(of: prepared.data) == type)
      let before = try #require(CGImageSourceCreateWithData(original as CFData, nil))
      let after = try #require(CGImageSourceCreateWithData(prepared.data as CFData, nil))
      #expect(CGImageSourceGetCount(before) == frames)
      #expect(CGImageSourceGetCount(after) == frames)
      for index in 0..<frames {
        #expect(try pixels(after, index) == pixels(before, index), "frame \(index)")
        let left = metadata(after, index)
        let orientation = ["{TIFF}.Orientation", "tiff:Orientation"]
        #expect(left.allSatisfy { orientation.contains($0) }, "\(left)")
        let was = CGImageSourceCopyPropertiesAtIndex(before, index, nil) as? [String: Any]
        let now = CGImageSourceCopyPropertiesAtIndex(after, index, nil) as? [String: Any]
        let kept = [kCGImagePropertyOrientation, kCGImagePropertyProfileName]
        for key in kept.map({ $0 as String }) {
          #expect(
            now?[key] as? NSObject == was?[key] as? NSObject,
            "\(key): \(String(describing: was?[key])) became \(String(describing: now?[key]))")
        }
      }
      for word in madeUp {
        #expect(prepared.data.range(of: Data(word.utf8)) == nil, "\(word) was sent")
      }
    }

    @Test func sendsACameraPhotoWithoutWhereOrWithWhatItWasTaken() async throws {
      let photo = try cameraJPEG()
      // As the camera wrote it: turned, with its place and camera, in Display P3.
      let source = try #require(CGImageSourceCreateWithData(photo as CFData, nil))
      let written = metadata(source, 0)
      for tag in ["{GPS}.Latitude", "{Exif}.LensModel", "{IPTC}.City", "{TIFF}.Make"]
        + ["xmp:CreatorTool"]
      {
        #expect(written.contains(tag), "\(tag) not in \(written)")
      }
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
      #expect(properties?[kCGImagePropertyOrientation as String] as? Int == 6)
      #expect(properties?[kCGImagePropertyProfileName as String] != nil)

      let prepared = await ComposerImage.prepare(photo)
      try expectPictures(of: photo, in: prepared, type: .jpeg, frames: 1)
      // It shows as the photo did, upright on its side.
      let shown = try #require(prepared.flatMap { UIImage(data: $0.data) })
      #expect(shown.imageOrientation == .right && shown.size == CGSize(width: 40, height: 60))
    }

    @Test func sendsAPNGWithoutItsText() async throws {
      let png = try editedPNG()
      #expect(png.range(of: Data("made up".utf8)) != nil)
      let prepared = await ComposerImage.prepare(png)
      try expectPictures(of: png, in: prepared, type: .png, frames: 1)
    }

    @Test func sendsEveryFrameOfAGIFWithoutItsComments() async throws {
      let gif = try commentedGIF()
      #expect(gif.range(of: Data("XMP DataXMP".utf8)) != nil)
      let prepared = await ComposerImage.prepare(gif)
      try expectPictures(of: gif, in: prepared, type: .gif, frames: 2)
    }

    @Test func sendsEveryFrameOfAWebPWithoutItsExifOrXMP() async throws {
      let webp = animatedWebP()
      #expect(webp.range(of: Data("Nowhere".utf8)) != nil)
      let prepared = await ComposerImage.prepare(webp)
      try expectPictures(of: webp, in: prepared, type: .webp, frames: 2)
    }

    /// A turned photo past the limit is drawn again upright, as a JPEG with none of its metadata.
    @Test func drawsATurnedPhotoPastTheLimitAgainUpright() async throws {
      let photo = try cameraJPEG(width: 600, height: 400)
      let limit = photo.count / 2
      let prepared = try #require(await ComposerImage.prepare(photo, limit: limit))
      #expect(prepared.type == .jpeg && prepared.data.count <= limit)
      let source = try #require(CGImageSourceCreateWithData(prepared.data as CFData, nil))
      let left = metadata(source, 0)
      #expect(left.isEmpty, "\(left)")
      for word in madeUp {
        #expect(prepared.data.range(of: Data(word.utf8)) == nil, "\(word) was sent")
      }
      let shown = try #require(UIImage(data: prepared.data))
      #expect(shown.imageOrientation == .up)
      #expect(abs(shown.size.width / shown.size.height - 400.0 / 600) < 0.01, "\(shown.size)")
    }

    /// A photo that doesn't read to its end, as one whose last bytes were lost, is drawn again
    /// upright as a JPEG with none of its metadata, never sent as it is.
    @Test func drawsAPhotoThatDoesntReadToItsEndAgain() async throws {
      let photo = try cameraJPEG()
      #expect(photo.suffix(2) == Data([0xFF, 0xD9]))
      let cut = Data(photo.dropLast(2))
      #expect(withoutMetadata(cut) == nil)
      let prepared = try #require(await ComposerImage.prepare(cut))
      #expect(prepared.type == .jpeg)
      let source = try #require(CGImageSourceCreateWithData(prepared.data as CFData, nil))
      let left = metadata(source, 0)
      #expect(left.isEmpty, "\(left)")
      for word in madeUp {
        #expect(prepared.data.range(of: Data(word.utf8)) == nil, "\(word) was sent")
      }
      let shown = try #require(UIImage(data: prepared.data))
      #expect(shown.imageOrientation == .up && shown.size == CGSize(width: 40, height: 60))
    }
  #endif
}
