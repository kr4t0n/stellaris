import Foundation
import Testing

@testable import BoardKit

/// Images built segment by segment and chunk by chunk, as a camera, an editor, or an encoder would
/// leave them, with a made-up camera and a made-up place in the Atlantic: what `withoutMetadata`
/// keeps is the picture's own bytes as they were, and the orientation alone.
@Suite struct ImageMetadataTests {
  // MARK: Exif

  /// A camera's Exif block: its make, the orientation, a maker's note in its Exif directory, and a
  /// place in its GPS directory, in either byte order.
  private func cameraExif(orientation: Int, littleEndian little: Bool) -> [UInt8] {
    func n(_ value: Int, _ size: Int) -> [UInt8] {
      let bytes = (0..<size).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
      return little ? bytes : bytes.reversed()
    }
    func entry(_ tag: Int, _ type: Int, _ count: Int, _ value: [UInt8]) -> [UInt8] {
      n(tag, 2) + n(type, 2) + n(count, 4) + value + Array(repeating: 0, count: 4 - value.count)
    }
    func rational(_ numerator: Int) -> [UInt8] { n(numerator, 4) + n(1, 4) }
    let make = 8 + 2 + 4 * 12 + 4
    let exif = make + 8
    let note = exif + 2 + 12 + 4
    let gps = note + 12
    let latitude = gps + 2 + 4 * 12 + 4
    let longitude = latitude + 24
    let header: [UInt8] = (little ? [0x49, 0x49] : [0x4D, 0x4D]) + n(42, 2) + n(8, 4)
    let first =
      n(4, 2) + entry(0x010F, 2, 8, n(make, 4)) + entry(0x0112, 3, 1, n(orientation, 2))
      + entry(0x8769, 4, 1, n(exif, 4)) + entry(0x8825, 4, 1, n(gps, 4)) + n(0, 4)
    let makers = Array("Example\0".utf8) + n(1, 2) + entry(0x927C, 7, 12, n(note, 4)) + n(0, 4)
    let place =
      Array("Note: made up".utf8.prefix(12)) + n(4, 2) + entry(0x0001, 2, 2, [0x53, 0])
      + entry(0x0002, 5, 3, n(latitude, 4)) + entry(0x0003, 2, 2, [0x57, 0])
      + entry(0x0004, 5, 3, n(longitude, 4)) + n(0, 4)
    return header + first + makers + place + rational(12) + rational(20) + rational(4)
      + rational(23) + rational(27) + rational(24)
  }

  @Test func readsTheOrientationInEitherByteOrder() {
    for orientation in 1...8 {
      for little in [true, false] {
        let exif = cameraExif(orientation: orientation, littleEndian: little)
        #expect(exifOrientation(exif[...]) == UInt8(orientation))
      }
    }
    // As a JPEG's segment holds it, after its own header.
    let segment = Array("Exif\0\0".utf8) + cameraExif(orientation: 6, littleEndian: true)
    #expect(exifOrientation(segment[...]) == 6)
    // None it can read is upright.
    #expect(exifOrientation(cameraExif(orientation: 9, littleEndian: true)[...]) == 1)
    #expect(exifOrientation(cameraExif(orientation: 0, littleEndian: false)[...]) == 1)
    #expect(exifOrientation(cameraExif(orientation: 6, littleEndian: true).prefix(30)) == 1)
    #expect(exifOrientation(Array("II*".utf8)[...]) == 1)
    #expect(exifOrientation(ArraySlice<UInt8>()) == 1)
    #expect(exifOrientation(orientationOnly(5)[...]) == 5)
  }

  @Test func checksAPNGsChunksAsZlibDoes() {
    #expect(crc32(Array("123456789".utf8)) == 0xCBF4_3926)
    #expect(crc32(Array("IEND".utf8)) == 0xAE42_6082)
  }

  // MARK: JPEG

  private func segment(_ marker: UInt8, _ payload: [UInt8]) -> [UInt8] {
    [0xFF, marker, UInt8((payload.count + 2) >> 8), UInt8((payload.count + 2) & 0xFF)] + payload
  }

  private let jfif = Array("JFIF\0".utf8) + [1, 2, 1, 0, 72, 0, 72]
  private let icc = Array("ICC_PROFILE\0".utf8) + [1, 1] + Array("a colour profile".utf8)
  private let adobe = Array("Adobe".utf8) + [0, 100, 0, 0, 0, 0, 1]
  private let xmp = Array("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>made up</x:xmpmeta>".utf8)

  /// A frame and its tables, then two scans with the 0xFF their data escapes and a restart in it.
  private var picture: [UInt8] {
    segment(0xDB, Array(repeating: 1, count: 65))
      + segment(0xC2, [8, 0, 2, 0, 3, 1, 1, 0x11, 0])
      + segment(0xC4, [0, 1] + Array(repeating: 0, count: 15) + [0])
      + segment(0xDA, [1, 1, 0, 0, 63, 0]) + [0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56]
      + segment(0xC4, [0x10, 1] + Array(repeating: 0, count: 15) + [0])
      + segment(0xDA, [1, 1, 0, 1, 63, 0]) + [0x78, 0xFF, 0xFF, 0xD9]
  }

  @Test func keepsAPhotosPictureAndColoursAndItsOrientationAlone() throws {
    let photo =
      [0xFF, 0xD8]
      + segment(0xE0, jfif + [1, 1, 0xAA, 0xBB, 0xCC])
      + segment(0xE1, Array("Exif\0\0".utf8) + cameraExif(orientation: 6, littleEndian: true))
      + segment(0xE1, xmp)
      + segment(0xE2, icc)
      + segment(0xE2, Array("MPF\0".utf8) + [0x49, 0x49, 0x2A, 0])
      + segment(0xED, Array("Photoshop 3.0\08BIM".utf8) + [4, 4] + Array("Nowhere".utf8))
      + segment(0xEE, adobe)
      + segment(0xFE, Array("made up".utf8))
      + picture
      // A picture a camera adds after the first, as an HDR gain map.
      + [0xFF, 0xD8] + segment(0xE1, xmp) + [0xFF, 0xD9]
    let kept = try #require(withoutMetadata(Data(photo)))
    // Stripped again, it stays as it is.
    #expect(withoutMetadata(kept) == kept)
    #expect(
      [UInt8](kept)
        == [0xFF, 0xD8] + segment(0xE0, jfif + [0, 0])
        + segment(0xE1, Array("Exif\0\0".utf8) + orientationOnly(6)) + segment(0xE2, icc)
        + segment(0xEE, adobe) + picture)
    #expect(exifOrientation([UInt8](kept)[(2 + 18 + 4 + 6)...]) == 6)
  }

  @Test func keepsAJPEGThatHoldsNoMetadataAsItIs() {
    let plain = [0xFF, 0xD8] + segment(0xE0, jfif + [0, 0]) + picture
    #expect(withoutMetadata(Data(plain)) == Data(plain))
    // Upright, a photo keeps no Exif at all; nor does a second Exif segment turn it.
    let exif = { (orientation: Int) in
      self.segment(
        0xE1,
        Array("Exif\0\0".utf8) + self.cameraExif(orientation: orientation, littleEndian: false))
    }
    let upright = [0xFF, 0xD8] + exif(1) + exif(3) + picture
    #expect(withoutMetadata(Data(upright)) == Data([0xFF, 0xD8] + picture))
  }

  @Test func keepsOnlyTheSegmentsThatDrawAJPEG() {
    let plain = [0xFF, 0xD8] + segment(0xE0, jfif + [0, 0]) + picture
    // An extension's segments, and the reserved JPG marker's, go like an application's.
    let extended =
      [0xFF, 0xD8] + segment(0xE0, jfif + [0, 0]) + segment(0xF0, Array("made up".utf8))
      + segment(0xC8, Array("Nowhere".utf8)) + picture
    #expect(withoutMetadata(Data(extended)) == Data(plain))
    // A marker no JPEG has outside a scan, however long it says it is, reads as nothing.
    for marker: UInt8 in [0x00, 0x02, 0x4D, 0xBF] {
      let odd =
        [0xFF, 0xD8] + segment(0xE0, jfif + [0, 0]) + [0xFF, marker, 0, 9]
        + Array("made up".utf8) + picture
      #expect(withoutMetadata(Data(odd)) == nil, "marker \(marker)")
    }
  }

  @Test func readsNoJPEGThatEndsEarly() {
    let whole = [0xFF, 0xD8] + segment(0xFE, Array("made up".utf8)) + picture
    #expect(withoutMetadata(Data(whole)) != nil)
    // Cut inside a segment, inside the scan, or before the end of the picture.
    for end in [5, 12, whole.count - 3, whole.count - 1] {
      #expect(withoutMetadata(Data(whole.prefix(end))) == nil, "cut at \(end)")
    }
    // A segment longer than what follows, and an end before any scan.
    #expect(withoutMetadata(Data([0xFF, 0xD8, 0xFF, 0xE1, 0x10, 0x00, 1, 2])) == nil)
    #expect(withoutMetadata(Data([0xFF, 0xD8, 0xFF, 0xD9])) == nil)
    #expect(withoutMetadata(Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 16])) == nil)
  }

  // MARK: PNG

  private func chunk(_ type: String, _ data: [UInt8]) -> [UInt8] {
    let body = Array(type.utf8) + data
    func n(_ value: UInt32) -> [UInt8] {
      (0..<4).reversed().map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
    }
    return n(UInt32(data.count)) + body + n(crc32(body))
  }

  private let signature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  private var header: [UInt8] { chunk("IHDR", [0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]) }

  @Test func keepsWhatDrawsAPNGAndItsOrientationAlone() throws {
    let drawn =
      chunk("iCCP", Array("Display\0\0".utf8) + [0x78, 0x9C])
      + chunk("pHYs", [0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1])
    // An APNG's two frames, the first its image data.
    let frames =
      chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]) + chunk("fcTL", Array(repeating: 0, count: 26))
      + chunk("IDAT", [0x78, 0x9C, 1, 2])
      + chunk("fcTL", [0, 0, 0, 1] + Array(repeating: 0, count: 22))
      + chunk("fdAT", [0, 0, 0, 2, 0x78, 0x9C, 3])
    let image =
      signature + header + drawn
      + chunk("eXIf", cameraExif(orientation: 8, littleEndian: false))
      + chunk("tEXt", Array("Comment\0made up".utf8))
      + chunk("zTXt", Array("Author\0\0".utf8) + [0x78, 0x9C])
      + chunk("iTXt", Array("XML:com.adobe.xmp\0\0\0\0\0".utf8) + xmp)
      + chunk("tIME", [7, 209, 2, 3, 4, 5, 6])
      + chunk("iDOT", Array(repeating: 0, count: 28))
      + frames + chunk("prVt", Array("Nowhere".utf8)) + chunk("IEND", [])
      + Array("after the end".utf8)
    let kept = try #require(withoutMetadata(Data(image)))
    // Stripped again, it stays as it is.
    #expect(withoutMetadata(kept) == kept)
    #expect(
      [UInt8](kept)
        == signature + header + drawn + chunk("eXIf", orientationOnly(8)) + frames
        + chunk("IEND", []))
  }

  @Test func keepsAPNGThatHoldsNoMetadataAsItIs() {
    let plain = signature + header + chunk("IDAT", [0x78, 0x9C, 1]) + chunk("IEND", [])
    #expect(withoutMetadata(Data(plain)) == Data(plain))
    let upright =
      signature + header + chunk("eXIf", cameraExif(orientation: 1, littleEndian: true))
      + chunk("IDAT", [0x78, 0x9C, 1]) + chunk("IEND", [])
    #expect(withoutMetadata(Data(upright)) == Data(plain))
    // No end, or a chunk longer than what follows.
    #expect(withoutMetadata(Data(plain.dropLast(12))) == nil)
    #expect(withoutMetadata(Data(plain.dropLast(13))) == nil)
    #expect(withoutMetadata(Data(signature + [0, 0, 0, 13] + Array("IHDR".utf8))) == nil)
  }

  // MARK: GIF

  private func subBlocks(_ data: [UInt8]) -> [UInt8] {
    stride(from: 0, to: data.count, by: 255).flatMap { start in
      let block = data[start..<min(start + 255, data.count)]
      return [UInt8(block.count)] + block
    } + [0]
  }

  /// An application extension: its name and code, eleven bytes, then its data.
  private func application(_ name: String, _ data: [UInt8]) -> [UInt8] {
    [0x21, 0xFF, 11] + Array(name.utf8) + subBlocks(data)
  }

  @Test func keepsEveryFrameOfAGIFAndWhatPlaysThem() throws {
    let screen = Array("GIF89a".utf8) + [2, 0, 2, 0, 0x80, 0, 0] + [0, 0, 0, 255, 255, 255]
    let loop = application("NETSCAPE2.0", [1, 0, 0])
    let timing: [UInt8] = [0x21, 0xF9, 4, 0, 10, 0, 0, 0]
    // The second frame has a colour table of its own, and LZW data longer than one sub-block.
    let first = [0x2C, 0, 0, 0, 0, 2, 0, 2, 0, 0] + [2] + subBlocks([0x44, 0x01])
    let second =
      [0x2C, 0, 0, 0, 0, 2, 0, 2, 0, 0x80] + [9, 9, 9, 0, 0, 0] + [2]
      + subBlocks(Array(repeating: 0x21, count: 300))
    let text = [0x21, 0x01] + subBlocks(Array(repeating: 0, count: 12) + Array("drawn".utf8))
    let image =
      screen + loop + [0x21, 0xFE] + subBlocks(Array("made up".utf8))
      + application("XMP DataXMP", xmp) + timing + first + application("Example 1.0", [0, 1])
      + timing + second + text + [0x3B] + Array("after the end".utf8)
    let kept = try #require(withoutMetadata(Data(image)))
    // Stripped again, it stays as it is.
    #expect(withoutMetadata(kept) == kept)
    #expect([UInt8](kept) == screen + loop + timing + first + timing + second + text + [0x3B])

    let plain = screen + first + [0x3B]
    #expect(withoutMetadata(Data(plain)) == Data(plain))
    // No trailer, a frame cut short, or a block of no kind.
    #expect(withoutMetadata(Data(plain.dropLast())) == nil)
    #expect(withoutMetadata(Data(plain.dropLast(3))) == nil)
    #expect(withoutMetadata(Data(screen + [0x00, 0x3B])) == nil)
  }

  // MARK: WebP

  private func riffChunk(_ type: String, _ data: [UInt8]) -> [UInt8] {
    let size = (0..<4).map { UInt8(truncatingIfNeeded: data.count >> ($0 * 8)) }
    return Array(type.utf8) + size + data + (data.count % 2 == 1 ? [0] : [])
  }

  private func webp(_ chunks: [UInt8]) -> [UInt8] {
    let size = (0..<4).map { UInt8(truncatingIfNeeded: (chunks.count + 4) >> ($0 * 8)) }
    return Array("RIFF".utf8) + size + Array("WEBP".utf8) + chunks
  }

  @Test func keepsEveryFrameOfAWebPAndItsOrientationAlone() throws {
    // Its colour profile, Exif, XMP, and animation, as its header's flags say.
    let canvas: [UInt8] = [1, 0, 0, 1, 0, 0]
    let header = { (flags: UInt8) in self.riffChunk("VP8X", [flags, 0, 0, 0] + canvas) }
    let colours = riffChunk("ICCP", Array("a colour profile".utf8))
    let animation = riffChunk("ANIM", [0, 0, 0, 0, 0, 0])
    let place: [UInt8] = [0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 100, 0, 0, 0]
    // A lossy frame with its alpha, and a lossless one of odd size.
    let lossy = riffChunk("ALPH", [0, 1, 2]) + riffChunk("VP8 ", [3, 4, 5, 6])
    let lossless = riffChunk("VP8L", [0x2F, 1, 2, 3, 4])
    let frames = riffChunk("ANMF", place + lossy) + riffChunk("ANMF", place + lossless)
    let image =
      webp(
        header(0x2E) + colours + animation
          + riffChunk("ANMF", place + lossy + riffChunk("NOTE", Array("made up".utf8)))
          + riffChunk("ANMF", place + lossless)
          + riffChunk("EXIF", cameraExif(orientation: 6, littleEndian: true))
          + riffChunk("XMP ", xmp) + riffChunk("NOTE", Array("Nowhere".utf8)))
      + Array("after the end".utf8)
    let kept = try #require(withoutMetadata(Data(image)))
    // Stripped again, it stays as it is.
    #expect(withoutMetadata(kept) == kept)
    #expect(
      [UInt8](kept)
        == webp(
          header(0x2A) + colours + animation + frames + riffChunk("EXIF", orientationOnly(6))))

    // Upright, it keeps no Exif, and its header says so.
    let upright = webp(
      header(0x0C) + lossless + riffChunk("EXIF", cameraExif(orientation: 1, littleEndian: false))
        + riffChunk("XMP ", xmp))
    #expect(withoutMetadata(Data(upright)) == Data(webp(header(0x00) + lossless)))
  }

  @Test func keepsAWebPThatHoldsNoMetadataAsItIs() {
    let simple = webp(riffChunk("VP8L", [0x2F, 1, 2, 3, 4]))
    #expect(withoutMetadata(Data(simple)) == Data(simple))
    // A RIFF longer than the file, or a chunk longer than the RIFF.
    var long = simple
    long[4] += 2
    #expect(withoutMetadata(Data(long)) == nil)
    let cut = webp(Array("VP8L".utf8) + [40, 0, 0, 0, 1, 2])
    #expect(withoutMetadata(Data(cut)) == nil)
    // A RIFF shorter than its own header, or holding nothing.
    for size: UInt8 in 0...4 {
      let header = Array("RIFF".utf8) + [size, 0, 0, 0] + Array("WEBP".utf8)
      #expect(withoutMetadata(Data(header)) == nil, "RIFF size \(size)")
    }
  }

  @Test func readsNothingButAnImage() {
    #expect(withoutMetadata(Data("<svg/>".utf8)) == nil)
    #expect(withoutMetadata(Data()) == nil)
    // As a slice of a larger buffer, whose indices don't start at zero.
    let plain = Data(
      [0, 0] + signature + header + chunk("IDAT", [0x78, 0x9C, 1]) + chunk("IEND", []))
    #expect(withoutMetadata(plain[2...]) == plain[2...])
  }
}
