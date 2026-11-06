import { imageTypeOf } from "@stellaris/shared";

/**
 * What the board leaves out of an image it keeps: everything an image carries beside its picture,
 * such as where a photo was taken (GPS), when and with what (Exif, TIFF, a maker's notes), and
 * what was written about it (IPTC, XMP, a PNG's text, a GIF's comments). What is kept is copied
 * byte for byte, never encoded again: the picture, its colour profile, and every frame. A port of
 * `withoutMetadata` in BoardKit (`apps/ios/BoardKit/Sources/BoardKit/ImageMetadata.swift`), which
 * the app runs before it posts, so an image it stripped comes out the same; the two run the table
 * in `apps/ios/fixtures/cases/image-metadata.json`.
 */

/**
 * `bytes` without their metadata, or null when they aren't a JPEG, PNG, GIF, or WebP that reads to
 * its end. What is kept:
 * - a JPEG's frame, tables, and scans, its JFIF header without a thumbnail, its ICC profile, and
 *   Adobe's colour transform, up to the end of its first picture, so what a camera adds after it
 *   (an HDR gain map, a motion photo's video) goes;
 * - a PNG's chunks that draw it: the header, palette, transparency, colour, physical size, and
 *   image data, an APNG's frames included;
 * - a GIF's frames, their timing and drawn text, its loop count, and its ICC profile;
 * - a WebP's frames, its alpha, its animation, and its ICC profile.
 *
 * The orientation an image's Exif gives stays, alone in an Exif block of its own, where it turns
 * the picture, so that it shows upright as it did.
 */
export function withoutMetadata(bytes: Uint8Array): Uint8Array | null {
  switch (imageTypeOf(bytes)) {
    case "jpeg":
      return jpegWithoutMetadata(bytes);
    case "png":
      return pngWithoutMetadata(bytes);
    case "gif":
      return gifWithoutMetadata(bytes);
    case "webp":
      return webpWithoutMetadata(bytes);
    default:
      return null;
  }
}

/**
 * The orientation the Exif block `tiff` gives in its first directory, from its TIFF header on: 1
 * to 8, or 1, upright, when it gives none that reads.
 */
export function exifOrientation(block: Uint8Array): number {
  const tiff = startsWith(block, EXIF_HEADER) ? block.subarray(EXIF_HEADER.length) : block;
  let little: boolean;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) {
    little = true;
  } else if (tiff[0] === 0x4d && tiff[1] === 0x4d) {
    little = false;
  } else {
    return 1;
  }
  const number = (offset: number, size: number): number | null =>
    offset >= 0 && size <= tiff.length && offset <= tiff.length - size
      ? numberAt(tiff, offset, size, little)
      : null;
  const directory = number(4, 4);
  const count = directory === null ? null : number(directory, 2);
  if (number(2, 2) !== 42 || directory === null || count === null) {
    return 1;
  }
  for (let entry = directory + 2; entry < directory + 2 + count * 12; entry += 12) {
    const tag = number(entry, 2);
    if (tag === null) {
      return 1;
    }
    // A SHORT, one of it, held in the first two bytes of the entry's value.
    if (tag === 0x0112) {
      const value = number(entry + 8, 2);
      if (
        number(entry + 2, 2) !== 3 ||
        number(entry + 4, 4) !== 1 ||
        value === null ||
        value < 1 ||
        value > 8
      ) {
        return 1;
      }
      return value;
    }
  }
  return 1;
}

/** A TIFF header and a directory holding `orientation` alone, as Exif keeps it. */
export function orientationOnly(orientation: number): Uint8Array {
  const block = new Uint8Array([
    0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  block[19] = orientation;
  return block;
}

/** The CRC-32 a PNG's chunk ends with, of its type and data. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable()[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let crcEntries: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (crcEntries === undefined) {
    crcEntries = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let crc = index;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      crcEntries[index] = crc >>> 0;
    }
  }
  return crcEntries;
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * What starts a JPEG's Exif segment, and sometimes a PNG's or a WebP's Exif, before its TIFF
 * header.
 */
const EXIF_HEADER = Uint8Array.of(0x45, 0x78, 0x69, 0x66, 0, 0);

function startsWith(bytes: Uint8Array, prefix: Uint8Array, at = 0): boolean {
  if (bytes.length - at < prefix.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[at + index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

/** The four bytes of a chunk's type at `at`, as text. */
function typeAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at] ?? 0,
    bytes[at + 1] ?? 0,
    bytes[at + 2] ?? 0,
    bytes[at + 3] ?? 0,
  );
}

/** The number the `size` bytes at `at` hold, read in place, since a chunk's size is read per chunk. */
function numberAt(bytes: Uint8Array, at: number, size: number, little = false): number {
  let value = 0;
  for (let index = 0; index < size; index += 1) {
    // Multiplied rather than shifted, so four bytes stay unsigned.
    value = value * 256 + (bytes[at + (little ? size - 1 - index : index)] ?? 0);
  }
  return value;
}

function bigEndian(value: number, size: number): number[] {
  return Array.from({ length: size }, (_, index) => (value >>> ((size - 1 - index) * 8)) & 0xff);
}

function littleEndian(value: number, size: number): number[] {
  return Array.from({ length: size }, (_, index) => (value >>> (index * 8)) & 0xff);
}

/**
 * Bytes written one piece after another, copied into one buffer as they come rather than kept as
 * pieces, since an image can hold millions of two-byte markers.
 */
class Kept {
  private buffer: Uint8Array;
  length = 0;

  constructor(capacity: number) {
    this.buffer = new Uint8Array(Math.max(capacity, 64));
  }

  add(piece: Uint8Array | readonly number[]): void {
    if (this.length + piece.length > this.buffer.length) {
      const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + piece.length));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(piece, this.length);
    this.length += piece.length;
  }

  /** Writes `piece` over what was kept from `at` on, as a size once what it measures is kept. */
  set(at: number, piece: readonly number[]): void {
    this.buffer.set(piece, at);
  }

  get bytes(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

// JPEG

/**
 * A JPEG's segments that draw it, up to the end of its first picture: its frame, tables, and
 * scans, with the JFIF header, the ICC profile, and Adobe's colour transform. A marker no JPEG has
 * outside a scan reads as nothing.
 */
function jpegWithoutMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  const kept = new Kept(bytes.length);
  kept.add([0xff, 0xd8]);
  let at = 2;
  let orientationKept = false;
  for (;;) {
    // Fill bytes may come before a marker.
    if (at + 1 >= bytes.length || bytes[at] !== 0xff) {
      return null;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (
      marker === 0x00 ||
      (marker >= 0x02 && marker <= 0xbf) ||
      marker === 0xd8 ||
      marker === 0xd9
    ) {
      // No marker, a reserved one, a second start, or an end before any scan.
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.add([0xff, marker]);
      at += 2;
      continue;
    }
    if (at + 4 > bytes.length) {
      return null;
    }
    const length = numberAt(bytes, at + 2, 2);
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) {
      return null;
    }
    const payload = bytes.subarray(at + 4, end);
    if (marker === 0xe0) {
      // JFIF's header, which says how to read the colours, without the thumbnail it may hold.
      if (startsWith(payload, JFIF) && payload.length >= 14) {
        kept.add([0xff, 0xe0, 0, 16]);
        kept.add(payload.subarray(0, 12));
        kept.add([0, 0]);
      }
    } else if (marker === 0xe1) {
      if (startsWith(payload, EXIF_HEADER) && !orientationKept) {
        orientationKept = true;
        const orientation = exifOrientation(payload.subarray(EXIF_HEADER.length));
        if (orientation !== 1) {
          const exif = orientationOnly(orientation);
          kept.add([0xff, 0xe1, ...bigEndian(EXIF_HEADER.length + exif.length + 2, 2)]);
          kept.add(EXIF_HEADER);
          kept.add(exif);
        }
      }
    } else if (
      (marker === 0xe2 && startsWith(payload, ICC_PROFILE)) ||
      (marker === 0xee && startsWith(payload, ADOBE)) ||
      // A frame, its tables, a scan, and their kin, JPEG-LS's frame and parameters among them.
      (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) ||
      (marker >= 0xda && marker <= 0xdf) ||
      marker === 0xf7 ||
      marker === 0xf8
    ) {
      kept.add(bytes.subarray(at, end));
    }
    // Any other application's data, XMP, IPTC, and maker data among them, a comment, or an
    // extension's, is left out.
    at = end;
    if (marker !== 0xda) {
      continue;
    }
    // A scan's data runs to the next marker other than a restart; a 0xFF in it is followed by 0.
    const scan = at;
    for (;;) {
      const next = bytes.indexOf(0xff, at);
      if (next === -1 || next + 1 >= bytes.length) {
        return null;
      }
      at = next;
      const after = bytes[at + 1] ?? 0;
      if (after !== 0 && after !== 0xff && !(after >= 0xd0 && after <= 0xd7)) {
        break;
      }
      at += 1;
    }
    kept.add(bytes.subarray(scan, at));
    if (bytes[at + 1] === 0xd9) {
      kept.add([0xff, 0xd9]);
      return kept.bytes;
    }
  }
}

const JFIF = Uint8Array.of(0x4a, 0x46, 0x49, 0x46, 0);
const ICC_PROFILE = ascii("ICC_PROFILE\0");
const ADOBE = ascii("Adobe");

// PNG

/** The chunks that draw a PNG or an APNG; any other, text and Exif among them, is left out. */
const PNG_DRAWING_CHUNKS: ReadonlySet<string> = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCV",
  "cLLI",
  "bKGD",
  "hIST",
  "pHYs",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
]);

/** A PNG's chunks up to its end, of the kinds that draw it. */
function pngWithoutMetadata(bytes: Uint8Array): Uint8Array | null {
  const kept = new Kept(bytes.length);
  kept.add(bytes.subarray(0, 8));
  let at = 8;
  let orientationKept = false;
  while (at + 12 <= bytes.length) {
    const length = numberAt(bytes, at, 4);
    const type = typeAt(bytes, at + 4);
    if (length > bytes.length - at - 12) {
      return null;
    }
    const end = at + 12 + length;
    if (PNG_DRAWING_CHUNKS.has(type)) {
      kept.add(bytes.subarray(at, end));
    } else if (type === "eXIf" && !orientationKept) {
      orientationKept = true;
      const orientation = exifOrientation(bytes.subarray(at + 8, at + 8 + length));
      if (orientation !== 1) {
        const data = new Uint8Array([...ascii("eXIf"), ...orientationOnly(orientation)]);
        kept.add(bigEndian(data.length - 4, 4));
        kept.add(data);
        kept.add(bigEndian(crc32(data), 4));
      }
    }
    if (type === "IEND") {
      return kept.bytes;
    }
    at = end;
  }
  return null;
}

// GIF

/** The application extensions that play a GIF: its loop count, under either name, and its ICC profile. */
const GIF_PLAYING_APPLICATIONS: readonly Uint8Array[] = [
  "NETSCAPE2.0",
  "ANIMEXTS1.0",
  "ICCRGBG1012",
].map(ascii);

/** The size of the colour table a GIF's packed field announces. */
function gifColourTable(packed: number): number {
  return packed & 0x80 ? 3 << ((packed & 0x07) + 1) : 0;
}

/**
 * A GIF's header, colour table, frames, and the extensions that play them, up to its trailer;
 * comments and any other application's data, XMP among them, are left out.
 */
function gifWithoutMetadata(bytes: Uint8Array): Uint8Array | null {
  /** Past the data sub-blocks that start at `start`, and their terminator. */
  const subBlocksEnd = (start: number): number | null => {
    let at = start;
    while (at < bytes.length) {
      const size = bytes[at] ?? 0;
      if (size === 0) {
        return at + 1;
      }
      at += 1 + size;
    }
    return null;
  };
  if (bytes.length < 13) {
    return null;
  }
  let at = 13 + gifColourTable(bytes[10] ?? 0);
  if (at > bytes.length) {
    return null;
  }
  const kept = new Kept(bytes.length);
  kept.add(bytes.subarray(0, at));
  while (at < bytes.length) {
    switch (bytes[at]) {
      case 0x2c: {
        // A frame: its descriptor, its own colour table, then its LZW code size and data.
        if (at + 10 > bytes.length) {
          return null;
        }
        const data = at + 10 + gifColourTable(bytes[at + 9] ?? 0);
        const end = data < bytes.length ? subBlocksEnd(data + 1) : null;
        if (end === null) {
          return null;
        }
        kept.add(bytes.subarray(at, end));
        at = end;
        break;
      }
      case 0x21: {
        const end = at + 2 < bytes.length ? subBlocksEnd(at + 2) : null;
        if (end === null) {
          return null;
        }
        const label = bytes[at + 1];
        // An application's name and code are its first sub-block, of 11 bytes, compared in place,
        // since a GIF can hold half a million extensions.
        const plays =
          label === 0xff &&
          bytes[at + 2] === 11 &&
          end >= at + 14 &&
          GIF_PLAYING_APPLICATIONS.some((name) => startsWith(bytes, name, at + 3));
        // A frame's timing, text drawn as a frame, or an application extension that plays it.
        if (label === 0xf9 || label === 0x01 || plays) {
          kept.add(bytes.subarray(at, end));
        }
        at = end;
        break;
      }
      case 0x3b:
        kept.add([0x3b]);
        return kept.bytes;
      default:
        return null;
    }
  }
  return null;
}

// WebP

/** The chunks that draw a WebP, in a file or in an animation's frame. */
const WEBP_DRAWING_CHUNKS: ReadonlySet<string> = new Set([
  "VP8X",
  "ICCP",
  "ANIM",
  "ANMF",
  "ALPH",
  "VP8 ",
  "VP8L",
]);

/**
 * A WebP's chunks that draw it, each frame's too, with its header's sizes and flags made to fit
 * what is kept.
 */
function webpWithoutMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12) {
    return null;
  }
  const end = 8 + numberAt(bytes, 4, 4, true);
  const chunks = end >= 12 && end <= bytes.length ? webpChunks(bytes.subarray(12, end)) : null;
  if (chunks === null || chunks.length === 0) {
    return null;
  }
  const kept = new Kept(chunks.length + 12);
  kept.add(ascii("RIFF"));
  kept.add(littleEndian(chunks.length + 4, 4));
  kept.add(ascii("WEBP"));
  kept.add(chunks);
  const image = kept.bytes;
  // VP8X, when it comes, comes first and says in its first byte whether Exif and XMP follow. One
  // of no bytes has none, and the byte after its header is the next chunk's.
  if (image.length > 20 && typeAt(image, 12) === "VP8X" && numberAt(image, 16, 4, true) > 0) {
    const exif = webpChunkTypes(image.subarray(12)).includes("EXIF");
    image[20] = ((image[20] ?? 0) & ~0x0c) | (exif ? 0x08 : 0);
  }
  return image;
}

/**
 * The chunks in `chunks` that draw the image, an animation's frames with their own chunks left
 * out in the same way, and an Exif block of the orientation alone when the image is turned. A
 * frame's chunks are read in turn with the file's, the frames it is inside kept on a stack, never
 * by a call of their own, since a file may nest frames inside frames however deep it likes, and a
 * decoder draws each. Null when the chunks don't read to their end.
 */
function webpChunks(chunks: Uint8Array): Uint8Array | null {
  const kept = new Kept(chunks.length);
  // The frames being read, the innermost last: where its chunks end, where the reading of the
  // chunks around it goes on, and where its size goes in what is kept.
  const frames: Array<{ end: number; resume: number; size: number }> = [];
  let end = chunks.length;
  let at = 0;
  let orientationKept = false;
  for (;;) {
    if (at >= end) {
      const frame = frames.pop();
      if (frame === undefined) {
        return kept.bytes;
      }
      kept.set(frame.size, littleEndian(kept.length - frame.size - 4, 4));
      at = frame.resume;
      end = frames.at(-1)?.end ?? chunks.length;
      continue;
    }
    if (end - at < 8) {
      return null;
    }
    const type = typeAt(chunks, at);
    const size = numberAt(chunks, at + 4, 4, true);
    if (size > end - at - 8) {
      return null;
    }
    const data = at + 8;
    // A chunk of odd size is padded to an even one, a pad the last may lack.
    at = Math.min(data + size + (size % 2), end);
    if (type === "ANMF") {
      // A frame's 16 bytes of placement and timing, then its own chunks. Its type, its size as it
      // came, written again once what is kept of its chunks is known, and the 16 bytes go first.
      if (size < 16) {
        return null;
      }
      frames.push({ end: data + size, resume: at, size: kept.length + 4 });
      kept.add(chunks.subarray(data - 8, data + 16));
      at = data + 16;
      end = data + size;
    } else if (WEBP_DRAWING_CHUNKS.has(type)) {
      // Its type and size as they came, then its data.
      kept.add(chunks.subarray(data - 8, data + size));
      if (size % 2 === 1) {
        kept.add([0]);
      }
    } else if (type === "EXIF" && frames.length === 0 && !orientationKept) {
      orientationKept = true;
      const turned = exifOrientation(chunks.subarray(data, data + size));
      if (turned !== 1) {
        const exif = orientationOnly(turned);
        kept.add(ascii(type));
        kept.add(littleEndian(exif.length, 4));
        kept.add(exif);
      }
    }
  }
}

/** The types of the chunks in `chunks`, which read to their end. */
function webpChunkTypes(chunks: Uint8Array): string[] {
  const types: string[] = [];
  let at = 0;
  while (chunks.length - at >= 8) {
    types.push(typeAt(chunks, at));
    const size = numberAt(chunks, at + 4, 4, true);
    at += 8 + size + (size % 2);
  }
  return types;
}
