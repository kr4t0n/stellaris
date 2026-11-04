// What the app leaves out of an image before it posts it: everything an image carries beside its
// picture, such as where a photo was taken (GPS), when and with what (Exif, TIFF, a maker's notes),
// and what was written about it (IPTC, XMP, a PNG's text, a GIF's comments). What is kept is copied
// byte for byte, never encoded again: the picture, its colour profile, and every frame.

import Foundation

/// `data` without its metadata, or nil when it isn't a JPEG, PNG, GIF, or WebP that reads to its
/// end. What is kept:
/// - a JPEG's frame, tables, and scans, its JFIF header without a thumbnail, its ICC profile, and
///   Adobe's colour transform, up to the end of its first picture, so what a camera adds after it
///   (an HDR gain map, a motion photo's video) goes;
/// - a PNG's chunks that draw it: the header, palette, transparency, colour, physical size, and
///   image data, an APNG's frames included;
/// - a GIF's frames, their timing and drawn text, its loop count, and its ICC profile;
/// - a WebP's frames, its alpha, its animation, and its ICC profile.
///
/// The orientation an image's Exif gives stays, alone in an Exif block of its own, where it turns
/// the picture, so that it shows upright as it did.
public func withoutMetadata(_ data: Data) -> Data? {
  let bytes = [UInt8](data)
  let kept: [UInt8]? =
    switch imageType(of: data) {
    case .jpeg: jpegWithoutMetadata(bytes)
    case .png: pngWithoutMetadata(bytes)
    case .gif: gifWithoutMetadata(bytes)
    case .webp: webpWithoutMetadata(bytes)
    case nil: nil
    }
  return kept.map { Data($0) }
}

/// The orientation the Exif block `tiff` gives in its first directory, from its TIFF header on: 1
/// to 8, or 1, upright, when it gives none that reads.
func exifOrientation(_ tiff: ArraySlice<UInt8>) -> UInt8 {
  let tiff = Array(tiff.starts(with: exifHeader) ? tiff.dropFirst(exifHeader.count) : tiff)
  let little: Bool
  switch tiff.prefix(2) {
  case [0x49, 0x49]: little = true
  case [0x4D, 0x4D]: little = false
  default: return 1
  }
  func number(at offset: Int, size: Int) -> Int? {
    guard offset >= 0, size <= tiff.count, offset <= tiff.count - size else {
      return nil
    }
    let field = tiff[offset..<offset + size]
    return (little ? field.reversed() : Array(field)).reduce(0) { $0 << 8 | Int($1) }
  }
  guard number(at: 2, size: 2) == 42, let directory = number(at: 4, size: 4),
    let count = number(at: directory, size: 2)
  else {
    return 1
  }
  for entry in stride(from: directory + 2, to: directory + 2 + count * 12, by: 12) {
    guard let tag = number(at: entry, size: 2) else {
      return 1
    }
    // A SHORT, one of it, held in the first two bytes of the entry's value.
    if tag == 0x0112 {
      guard number(at: entry + 2, size: 2) == 3, number(at: entry + 4, size: 4) == 1,
        let value = number(at: entry + 8, size: 2), (1...8).contains(value)
      else {
        return 1
      }
      return UInt8(value)
    }
  }
  return 1
}

/// A TIFF header and a directory holding `orientation` alone, as Exif keeps it.
func orientationOnly(_ orientation: UInt8) -> [UInt8] {
  [0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0]
    + [0, 0, 0, 0]
}

/// What starts a JPEG's Exif segment, and sometimes a PNG's or a WebP's Exif, before its TIFF
/// header.
private let exifHeader: [UInt8] = Array("Exif".utf8) + [0, 0]

private func ascii(_ text: String) -> [UInt8] { Array(text.utf8) }

private func bigEndian(_ value: Int, size: Int) -> [UInt8] {
  (0..<size).reversed().map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
}

private func littleEndian(_ value: Int, size: Int) -> [UInt8] {
  (0..<size).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
}

private func number(_ bytes: ArraySlice<UInt8>, littleEndian little: Bool = false) -> Int {
  (little ? bytes.reversed() : Array(bytes)).reduce(0) { $0 << 8 | Int($1) }
}

// MARK: - JPEG

/// A JPEG's segments up to the end of its first picture, without those of an application or a
/// comment but for the JFIF header, the ICC profile, and Adobe's colour transform.
private func jpegWithoutMetadata(_ bytes: [UInt8]) -> [UInt8]? {
  guard bytes.starts(with: [0xFF, 0xD8]) else {
    return nil
  }
  var kept: [UInt8] = [0xFF, 0xD8]
  kept.reserveCapacity(bytes.count)
  var at = 2
  var orientationKept = false
  while true {
    // Fill bytes may come before a marker.
    guard at + 1 < bytes.count, bytes[at] == 0xFF else {
      return nil
    }
    let marker = bytes[at + 1]
    if marker == 0xFF {
      at += 1
      continue
    }
    switch marker {
    case 0xD8, 0xD9:
      // A second start, or an end before any scan.
      return nil
    case 0x01, 0xD0...0xD7:
      kept += [0xFF, marker]
      at += 2
      continue
    default:
      break
    }
    guard at + 4 <= bytes.count else {
      return nil
    }
    let length = number(bytes[at + 2..<at + 4])
    let end = at + 2 + length
    guard length >= 2, end <= bytes.count else {
      return nil
    }
    let payload = bytes[at + 4..<end]
    switch marker {
    case 0xE0:
      // JFIF's header, which says how to read the colours, without the thumbnail it may hold.
      if payload.starts(with: ascii("JFIF") + [0]), payload.count >= 14 {
        kept += [0xFF, 0xE0, 0, 16] + payload.prefix(12) + [0, 0]
      }
    case 0xE1:
      if payload.starts(with: exifHeader), !orientationKept {
        orientationKept = true
        let orientation = exifOrientation(payload.dropFirst(exifHeader.count))
        if orientation != 1 {
          let exif = exifHeader + orientationOnly(orientation)
          kept += [0xFF, 0xE1] + bigEndian(exif.count + 2, size: 2) + exif
        }
      }
    case 0xE2 where payload.starts(with: ascii("ICC_PROFILE") + [0]),
      0xEE where payload.starts(with: ascii("Adobe")):
      kept += bytes[at..<end]
    case 0xE0...0xEF, 0xFE:
      // Any other application's data, XMP, IPTC, and maker data among them, or a comment.
      break
    default:
      kept += bytes[at..<end]
    }
    at = end
    guard marker == 0xDA else {
      continue
    }
    // A scan's data runs to the next marker other than a restart; a 0xFF in it is followed by 0.
    let scan = at
    while at + 1 < bytes.count {
      if bytes[at] == 0xFF, bytes[at + 1] != 0, bytes[at + 1] != 0xFF,
        !(0xD0...0xD7).contains(bytes[at + 1])
      {
        break
      }
      at += 1
    }
    guard at + 1 < bytes.count else {
      return nil
    }
    kept += bytes[scan..<at]
    if bytes[at + 1] == 0xD9 {
      return kept + [0xFF, 0xD9]
    }
  }
}

// MARK: - PNG

/// The chunks that draw a PNG or an APNG; any other, text and Exif among them, is left out.
private let pngDrawingChunks: Set<[UInt8]> = Set(
  [
    "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP", "mDCV",
    "cLLI", "bKGD", "hIST", "pHYs", "sPLT", "acTL", "fcTL", "fdAT",
  ].map(ascii))

/// A PNG's chunks up to its end, of the kinds that draw it.
private func pngWithoutMetadata(_ bytes: [UInt8]) -> [UInt8]? {
  var kept = Array(bytes.prefix(8))
  kept.reserveCapacity(bytes.count)
  var at = 8
  var orientationKept = false
  while at + 12 <= bytes.count {
    let length = number(bytes[at..<at + 4])
    let type = Array(bytes[at + 4..<at + 8])
    guard length <= bytes.count - at - 12 else {
      return nil
    }
    let end = at + 12 + length
    if pngDrawingChunks.contains(type) {
      kept += bytes[at..<end]
    } else if type == ascii("eXIf"), !orientationKept {
      orientationKept = true
      let orientation = exifOrientation(bytes[at + 8..<at + 8 + length])
      if orientation != 1 {
        let data = ascii("eXIf") + orientationOnly(orientation)
        kept += bigEndian(data.count - 4, size: 4) + data + bigEndian(Int(crc32(data)), size: 4)
      }
    }
    if type == ascii("IEND") {
      return kept
    }
    at = end
  }
  return nil
}

/// The CRC-32 a PNG's chunk ends with, of its type and data.
func crc32(_ bytes: [UInt8]) -> UInt32 {
  ~bytes.reduce(~UInt32(0)) { crc, byte in crcTable[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8) }
}

private let crcTable: [UInt32] = (0..<256).map { index in
  (0..<8).reduce(UInt32(index)) { crc, _ in crc & 1 == 1 ? 0xEDB8_8320 ^ (crc >> 1) : crc >> 1 }
}

// MARK: - GIF

/// The application extensions that play a GIF: its loop count, under either name, and its ICC
/// profile.
private let gifPlayingApplications: Set<[UInt8]> = Set(
  ["NETSCAPE2.0", "ANIMEXTS1.0", "ICCRGBG1012"].map(ascii))

/// A GIF's header, colour table, frames, and the extensions that play them, up to its trailer;
/// comments and any other application's data, XMP among them, are left out.
private func gifWithoutMetadata(_ bytes: [UInt8]) -> [UInt8]? {
  /// Past the data sub-blocks that start at `start`, and their terminator.
  func subBlocksEnd(_ start: Int) -> Int? {
    var at = start
    while at < bytes.count {
      if bytes[at] == 0 {
        return at + 1
      }
      at += 1 + Int(bytes[at])
    }
    return nil
  }
  /// The size of the colour table a packed field announces.
  func colourTable(_ packed: UInt8) -> Int { packed & 0x80 == 0 ? 0 : 3 << (Int(packed & 0x07) + 1) }

  guard bytes.count >= 13 else {
    return nil
  }
  var at = 13 + colourTable(bytes[10])
  guard at <= bytes.count else {
    return nil
  }
  var kept = Array(bytes[..<at])
  kept.reserveCapacity(bytes.count)
  while at < bytes.count {
    switch bytes[at] {
    case 0x2C:
      // A frame: its descriptor, its own colour table, then its LZW code size and data.
      guard at + 10 <= bytes.count else {
        return nil
      }
      let data = at + 10 + colourTable(bytes[at + 9])
      guard data < bytes.count, let end = subBlocksEnd(data + 1) else {
        return nil
      }
      kept += bytes[at..<end]
      at = end
    case 0x21:
      guard at + 2 < bytes.count, let end = subBlocksEnd(at + 2) else {
        return nil
      }
      let label = bytes[at + 1]
      let application = bytes[at + 2] == 11 ? Array(bytes[at + 3..<min(at + 14, end)]) : []
      // A frame's timing, text drawn as a frame, or an application extension that plays it.
      if label == 0xF9 || label == 0x01
        || (label == 0xFF && gifPlayingApplications.contains(application))
      {
        kept += bytes[at..<end]
      }
      at = end
    case 0x3B:
      return kept + [0x3B]
    default:
      return nil
    }
  }
  return nil
}

// MARK: - WebP

/// The chunks that draw a WebP, in a file or in an animation's frame.
private let webpDrawingChunks: Set<[UInt8]> = Set(
  ["VP8X", "ICCP", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"].map(ascii))

/// A WebP's chunks that draw it, each frame's too, with its header's sizes and flags made to fit
/// what is kept.
private func webpWithoutMetadata(_ bytes: [UInt8]) -> [UInt8]? {
  guard bytes.count >= 12 else {
    return nil
  }
  let end = 8 + number(bytes[4..<8], littleEndian: true)
  guard end <= bytes.count, let chunks = webpChunks(bytes[12..<end], orientation: true),
    !chunks.isEmpty
  else {
    return nil
  }
  var kept = ascii("RIFF") + littleEndian(chunks.count + 4, size: 4) + ascii("WEBP") + chunks
  // VP8X, when it comes, comes first and says whether Exif and XMP follow.
  if kept.count > 20, kept[12..<16].elementsEqual(ascii("VP8X")) {
    let exif = webpChunkTypes(kept[12...]).contains(ascii("EXIF"))
    kept[20] = kept[20] & ~0x0C | (exif ? 0x08 : 0)
  }
  return kept
}

/// The chunks in `chunks` that draw the image, an animation's frames with their own chunks left
/// out in the same way, and an Exif block of the orientation alone when `orientation` is true and
/// the image is turned. Nil when the chunks don't read to their end.
private func webpChunks(_ chunks: ArraySlice<UInt8>, orientation: Bool) -> [UInt8]? {
  var kept: [UInt8] = []
  var at = chunks.startIndex
  var orientationKept = false
  while at < chunks.endIndex {
    guard chunks.endIndex - at >= 8 else {
      return nil
    }
    let type = Array(chunks[at..<at + 4])
    let size = number(chunks[at + 4..<at + 8], littleEndian: true)
    guard size <= chunks.endIndex - at - 8 else {
      return nil
    }
    let data = chunks[at + 8..<at + 8 + size]
    // A chunk of odd size is padded to an even one, a pad the last may lack.
    at = min(at + 8 + size + size % 2, chunks.endIndex)
    if type == ascii("ANMF") {
      // A frame's 16 bytes of placement and timing, then its own chunks.
      guard data.count >= 16, let frame = webpChunks(data.dropFirst(16), orientation: false) else {
        return nil
      }
      kept += type + littleEndian(16 + frame.count, size: 4) + data.prefix(16) + frame
    } else if webpDrawingChunks.contains(type) {
      kept += type + littleEndian(size, size: 4) + data + (size % 2 == 1 ? [0] : [])
    } else if type == ascii("EXIF"), orientation, !orientationKept {
      orientationKept = true
      let turned = exifOrientation(data)
      if turned != 1 {
        let exif = orientationOnly(turned)
        kept += type + littleEndian(exif.count, size: 4) + exif
      }
    }
  }
  return kept
}

/// The types of the chunks in `chunks`, which read to their end.
private func webpChunkTypes(_ chunks: ArraySlice<UInt8>) -> [[UInt8]] {
  var types: [[UInt8]] = []
  var at = chunks.startIndex
  while chunks.endIndex - at >= 8 {
    types.append(Array(chunks[at..<at + 4]))
    let size = number(chunks[at + 4..<at + 8], littleEndian: true)
    at += 8 + size + size % 2
  }
  return types
}
