import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, exifOrientation, orientationOnly, withoutMetadata } from "./image-metadata.js";

/**
 * Images built segment by segment and chunk by chunk, as a camera, an editor, or an encoder would
 * leave them, with a made-up camera and a made-up place in the Atlantic, as BoardKit's
 * `ImageMetadataTests` builds them: what `withoutMetadata` keeps is the picture's own bytes as
 * they were, and the orientation alone. Every case goes to `apps/ios/fixtures/cases`, where
 * BoardKit's port runs the same table.
 */

type Bytes = readonly number[];

const text = (value: string): number[] => [...Buffer.from(value, "latin1")];
const zeros = (count: number): number[] => Array.from({ length: count }, () => 0);
const hex = (bytes: Uint8Array | Bytes | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString("hex");

// Exif

/**
 * A camera's Exif block: its make, the orientation, a maker's note in its Exif directory, and a
 * place in its GPS directory, in either byte order.
 */
function cameraExif(orientation: number, little: boolean): number[] {
  const n = (value: number, size: number): number[] => {
    const bytes = Array.from({ length: size }, (_, index) => (value >>> (index * 8)) & 0xff);
    return little ? bytes : bytes.toReversed();
  };
  const entry = (tag: number, type: number, count: number, value: Bytes): number[] => [
    ...n(tag, 2),
    ...n(type, 2),
    ...n(count, 4),
    ...value,
    ...zeros(4 - value.length),
  ];
  const rational = (numerator: number): number[] => [...n(numerator, 4), ...n(1, 4)];
  const make = 8 + 2 + 4 * 12 + 4;
  const exif = make + 8;
  const note = exif + 2 + 12 + 4;
  const gps = note + 12;
  const latitude = gps + 2 + 4 * 12 + 4;
  const longitude = latitude + 24;
  const header = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...n(42, 2), ...n(8, 4)];
  const first = [
    ...n(4, 2),
    ...entry(0x010f, 2, 8, n(make, 4)),
    ...entry(0x0112, 3, 1, n(orientation, 2)),
    ...entry(0x8769, 4, 1, n(exif, 4)),
    ...entry(0x8825, 4, 1, n(gps, 4)),
    ...n(0, 4),
  ];
  const makers = [
    ...text("Example\0"),
    ...n(1, 2),
    ...entry(0x927c, 7, 12, n(note, 4)),
    ...n(0, 4),
  ];
  const place = [
    ...text("Note: made up").slice(0, 12),
    ...n(4, 2),
    ...entry(0x0001, 2, 2, [0x53, 0]),
    ...entry(0x0002, 5, 3, n(latitude, 4)),
    ...entry(0x0003, 2, 2, [0x57, 0]),
    ...entry(0x0004, 5, 3, n(longitude, 4)),
    ...n(0, 4),
  ];
  return [...header, ...first, ...makers, ...place, ...[12, 20, 4, 23, 27, 24].flatMap(rational)];
}

const only = (orientation: number): number[] => [...orientationOnly(orientation)];

// JPEG

const segment = (marker: number, payload: Bytes): number[] => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 0xff,
  ...payload,
];

const jfif = [...text("JFIF\0"), 1, 2, 1, 0, 72, 0, 72];
const icc = [...text("ICC_PROFILE\0"), 1, 1, ...text("a colour profile")];
const adobe = [...text("Adobe"), 0, 100, 0, 0, 0, 0, 1];
const xmp = text("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>made up</x:xmpmeta>");
const exifHeader = text("Exif\0\0");

/** A frame and its tables, then two scans with the 0xFF their data escapes and a restart in it. */
const picture = [
  ...segment(
    0xdb,
    Array.from({ length: 65 }, () => 1),
  ),
  ...segment(0xc2, [8, 0, 2, 0, 3, 1, 1, 0x11, 0]),
  ...segment(0xc4, [0, 1, ...zeros(15), 0]),
  ...segment(0xda, [1, 1, 0, 0, 63, 0]),
  0x12,
  0xff,
  0x00,
  0x34,
  0xff,
  0xd0,
  0x56,
  ...segment(0xc4, [0x10, 1, ...zeros(15), 0]),
  ...segment(0xda, [1, 1, 0, 1, 63, 0]),
  0x78,
  0xff,
  0xff,
  0xd9,
];

const plainJpeg = [0xff, 0xd8, ...segment(0xe0, [...jfif, 0, 0]), ...picture];

// PNG

const bigEndian32 = (value: number): number[] =>
  [3, 2, 1, 0].map((at) => (value >>> (at * 8)) & 0xff);

const chunk = (type: string, data: Bytes): number[] => {
  const body = [...text(type), ...data];
  return [...bigEndian32(data.length), ...body, ...bigEndian32(zlibCrc32(Buffer.from(body)))];
};

const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngHeader = chunk("IHDR", [0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
const plainPng = [
  ...signature,
  ...pngHeader,
  ...chunk("IDAT", [0x78, 0x9c, 1]),
  ...chunk("IEND", []),
];

// GIF

const subBlocks = (data: Bytes): number[] => {
  const blocks: number[] = [];
  for (let start = 0; start < data.length; start += 255) {
    const block = data.slice(start, start + 255);
    blocks.push(block.length, ...block);
  }
  return [...blocks, 0];
};

/** An application extension: its name and code, eleven bytes, then its data. */
const application = (name: string, data: Bytes): number[] => [
  0x21,
  0xff,
  11,
  ...text(name),
  ...subBlocks(data),
];

const screen = [...text("GIF89a"), 2, 0, 2, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
const firstFrame = [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, ...subBlocks([0x44, 0x01])];

// WebP

const riffChunk = (type: string, data: Bytes): number[] => [
  ...text(type),
  ...[0, 1, 2, 3].map((at) => (data.length >>> (at * 8)) & 0xff),
  ...data,
  ...(data.length % 2 === 1 ? [0] : []),
];

const webp = (chunks: Bytes): number[] => [
  ...text("RIFF"),
  ...[0, 1, 2, 3].map((at) => ((chunks.length + 4) >>> (at * 8)) & 0xff),
  ...text("WEBP"),
  ...chunks,
];

const vp8x = (flags: number): number[] => riffChunk("VP8X", [flags, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
const colours = riffChunk("ICCP", text("a colour profile"));
const animation = riffChunk("ANIM", [0, 0, 0, 0, 0, 0]);
const place = [0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 100, 0, 0, 0];
// A lossy frame with its alpha, and a lossless one of odd size.
const lossy = [...riffChunk("ALPH", [0, 1, 2]), ...riffChunk("VP8 ", [3, 4, 5, 6])];
const lossless = riffChunk("VP8L", [0x2f, 1, 2, 3, 4]);
const simpleWebp = webp(lossless);

/** A WebP whose frames nest `depth` deep, each holding the next. */
function nestedFrames(depth: number): Uint8Array {
  // Written into one buffer, since spreading 100,000 levels into arrays would take minutes.
  const bytes = new Uint8Array(12 + 24 * depth + lossless.length);
  const view = new DataView(bytes.buffer);
  bytes.set(text("RIFF"), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(text("WEBP"), 8);
  for (let level = 0; level < depth; level += 1) {
    const at = 12 + 24 * level;
    bytes.set(text("ANMF"), at);
    view.setUint32(at + 4, bytes.length - at - 8, true);
    bytes.set(place, at + 8);
  }
  bytes.set(lossless, 12 + 24 * depth);
  return bytes;
}

/** A case of the table: an image, and what `withoutMetadata` keeps of it, or null for none. */
interface Case {
  name: string;
  image: Bytes;
  kept: Bytes | null;
}

const cameraJpeg = {
  image: [
    0xff,
    0xd8,
    ...segment(0xe0, [...jfif, 1, 1, 0xaa, 0xbb, 0xcc]),
    ...segment(0xe1, [...exifHeader, ...cameraExif(6, true)]),
    ...segment(0xe1, xmp),
    ...segment(0xe2, icc),
    ...segment(0xe2, [...text("MPF\0"), 0x49, 0x49, 0x2a, 0]),
    ...segment(0xed, [...text("Photoshop 3.0\x008BIM"), 4, 4, ...text("Nowhere")]),
    ...segment(0xee, adobe),
    ...segment(0xfe, text("made up")),
    ...picture,
    // A picture a camera adds after the first, as an HDR gain map.
    0xff,
    0xd8,
    ...segment(0xe1, xmp),
    0xff,
    0xd9,
  ],
  kept: [
    0xff,
    0xd8,
    ...segment(0xe0, [...jfif, 0, 0]),
    ...segment(0xe1, [...exifHeader, ...only(6)]),
    ...segment(0xe2, icc),
    ...segment(0xee, adobe),
    ...picture,
  ],
};

const apngFrames = [
  ...chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]),
  ...chunk("fcTL", zeros(26)),
  ...chunk("IDAT", [0x78, 0x9c, 1, 2]),
  ...chunk("fcTL", [0, 0, 0, 1, ...zeros(22)]),
  ...chunk("fdAT", [0, 0, 0, 2, 0x78, 0x9c, 3]),
];
const pngDrawn = [
  ...chunk("iCCP", [...text("Display\0\0"), 0x78, 0x9c]),
  ...chunk("pHYs", [0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1]),
];
const cameraPng = {
  image: [
    ...signature,
    ...pngHeader,
    ...pngDrawn,
    ...chunk("eXIf", cameraExif(8, false)),
    ...chunk("tEXt", text("Comment\0made up")),
    ...chunk("zTXt", [...text("Author\0\0"), 0x78, 0x9c]),
    ...chunk("iTXt", [...text("XML:com.adobe.xmp\0\0\0\0\0"), ...xmp]),
    ...chunk("tIME", [7, 209, 2, 3, 4, 5, 6]),
    ...chunk("iDOT", zeros(28)),
    ...apngFrames,
    ...chunk("prVt", text("Nowhere")),
    ...chunk("IEND", []),
    ...text("after the end"),
  ],
  kept: [
    ...signature,
    ...pngHeader,
    ...pngDrawn,
    ...chunk("eXIf", only(8)),
    ...apngFrames,
    ...chunk("IEND", []),
  ],
};

const loop = application("NETSCAPE2.0", [1, 0, 0]);
const timing = [0x21, 0xf9, 4, 0, 10, 0, 0, 0];
// The second frame has a colour table of its own, and LZW data longer than one sub-block.
const secondFrame = [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0x80, 9, 9, 9, 0, 0, 0, 2].concat(
  subBlocks(Array.from({ length: 300 }, () => 0x21)),
);
const drawnText = [0x21, 0x01, ...subBlocks([...zeros(12), ...text("drawn")])];
const animatedGif = {
  image: [
    ...screen,
    ...loop,
    0x21,
    0xfe,
    ...subBlocks(text("made up")),
    ...application("XMP DataXMP", xmp),
    ...timing,
    ...firstFrame,
    ...application("Example 1.0", [0, 1]),
    ...timing,
    ...secondFrame,
    ...drawnText,
    0x3b,
    ...text("after the end"),
  ],
  kept: [
    ...screen,
    ...loop,
    ...timing,
    ...firstFrame,
    ...timing,
    ...secondFrame,
    ...drawnText,
    0x3b,
  ],
};

const animatedWebp = {
  // Its colour profile, Exif, XMP, and animation, as its header's flags say.
  image: [
    ...webp([
      ...vp8x(0x2e),
      ...colours,
      ...animation,
      ...riffChunk("ANMF", [...place, ...lossy, ...riffChunk("NOTE", text("made up"))]),
      ...riffChunk("ANMF", [...place, ...lossless]),
      ...riffChunk("EXIF", cameraExif(6, true)),
      ...riffChunk("XMP ", xmp),
      ...riffChunk("NOTE", text("Nowhere")),
    ]),
    ...text("after the end"),
  ],
  kept: webp([
    ...vp8x(0x2a),
    ...colours,
    ...animation,
    ...riffChunk("ANMF", [...place, ...lossy]),
    ...riffChunk("ANMF", [...place, ...lossless]),
    ...riffChunk("EXIF", only(6)),
  ]),
};

const cutJpeg = [0xff, 0xd8, ...segment(0xfe, text("made up")), ...picture];

const CASES: Case[] = [
  // JPEG
  { name: "a camera's JPEG", ...cameraJpeg },
  { name: "a camera's JPEG as the app sends it", image: cameraJpeg.kept, kept: cameraJpeg.kept },
  { name: "a JPEG that holds no metadata", image: plainJpeg, kept: plainJpeg },
  {
    name: "an upright JPEG, whose second Exif segment turns nothing",
    image: [
      0xff,
      0xd8,
      ...segment(0xe1, [...exifHeader, ...cameraExif(1, false)]),
      ...segment(0xe1, [...exifHeader, ...cameraExif(3, false)]),
      ...picture,
    ],
    kept: [0xff, 0xd8, ...picture],
  },
  {
    name: "a JPEG with an extension's segment and the reserved JPG marker's",
    image: [
      0xff,
      0xd8,
      ...segment(0xe0, [...jfif, 0, 0]),
      ...segment(0xf0, text("made up")),
      ...segment(0xc8, text("Nowhere")),
      ...picture,
    ],
    kept: plainJpeg,
  },
  ...[0x00, 0x02, 0x4d, 0xbf].map((marker) => ({
    name: `a JPEG with marker 0x${marker.toString(16).padStart(2, "0")}, which no JPEG has outside a scan`,
    image: [
      0xff,
      0xd8,
      ...segment(0xe0, [...jfif, 0, 0]),
      0xff,
      marker,
      0,
      9,
      ...text("made up"),
      ...picture,
    ],
    kept: null,
  })),
  { name: "a JPEG with a comment", image: cutJpeg, kept: [0xff, 0xd8, ...picture] },
  ...[5, 12, cutJpeg.length - 3, cutJpeg.length - 1].map((end) => ({
    name: `a JPEG cut at byte ${end} of ${cutJpeg.length}`,
    image: cutJpeg.slice(0, end),
    kept: null,
  })),
  {
    name: "a JPEG segment longer than what follows",
    image: [0xff, 0xd8, 0xff, 0xe1, 0x10, 0x00, 1, 2],
    kept: null,
  },
  { name: "a JPEG that ends before any scan", image: [0xff, 0xd8, 0xff, 0xd9], kept: null },
  { name: "a JPEG cut in its JFIF header", image: [0xff, 0xd8, 0xff, 0xe0, 0, 16], kept: null },
  // PNG
  { name: "a camera's APNG", ...cameraPng },
  { name: "a camera's APNG as the app sends it", image: cameraPng.kept, kept: cameraPng.kept },
  { name: "a PNG that holds no metadata", image: plainPng, kept: plainPng },
  {
    name: "an upright PNG",
    image: [
      ...signature,
      ...pngHeader,
      ...chunk("eXIf", cameraExif(1, true)),
      ...chunk("IDAT", [0x78, 0x9c, 1]),
      ...chunk("IEND", []),
    ],
    kept: plainPng,
  },
  { name: "a PNG with no end", image: plainPng.slice(0, -12), kept: null },
  { name: "a PNG cut in its last chunk", image: plainPng.slice(0, -13), kept: null },
  {
    name: "a PNG chunk longer than what follows",
    image: [...signature, 0, 0, 0, 13, ...text("IHDR")],
    kept: null,
  },
  // GIF
  { name: "an animated GIF", ...animatedGif },
  { name: "an animated GIF as the app sends it", image: animatedGif.kept, kept: animatedGif.kept },
  {
    name: "a GIF that holds no metadata",
    image: [...screen, ...firstFrame, 0x3b],
    kept: [...screen, ...firstFrame, 0x3b],
  },
  { name: "a GIF with no trailer", image: [...screen, ...firstFrame], kept: null },
  { name: "a GIF frame cut short", image: [...screen, ...firstFrame].slice(0, -2), kept: null },
  { name: "a GIF block of no kind", image: [...screen, 0x00, 0x3b], kept: null },
  // WebP
  { name: "an animated WebP", ...animatedWebp },
  {
    name: "an animated WebP as the app sends it",
    image: animatedWebp.kept,
    kept: animatedWebp.kept,
  },
  {
    name: "an upright WebP, whose header then says it holds no Exif or XMP",
    image: webp([
      ...vp8x(0x0c),
      ...lossless,
      ...riffChunk("EXIF", cameraExif(1, false)),
      ...riffChunk("XMP ", xmp),
    ]),
    kept: webp([...vp8x(0x00), ...lossless]),
  },
  { name: "a WebP that holds no metadata", image: simpleWebp, kept: simpleWebp },
  {
    name: "a WebP whose VP8X holds no bytes, before a chunk it keeps",
    image: webp([...riffChunk("VP8X", []), ...lossless]),
    kept: webp([...riffChunk("VP8X", []), ...lossless]),
  },
  {
    name: "a turned WebP whose VP8X holds no bytes",
    image: webp([...riffChunk("VP8X", []), ...lossless, ...riffChunk("EXIF", cameraExif(6, true))]),
    kept: webp([...riffChunk("VP8X", []), ...lossless, ...riffChunk("EXIF", only(6))]),
  },
  {
    name: "a WebP whose RIFF is longer than the file",
    image: simpleWebp.map((byte, index) => (index === 4 ? byte + 2 : byte)),
    kept: null,
  },
  {
    name: "a WebP chunk longer than the RIFF",
    image: webp([...text("VP8L"), 40, 0, 0, 0, 1, 2]),
    kept: null,
  },
  ...[0, 1, 2, 3, 4].map((size) => ({
    name: `a WebP's header alone, its RIFF ${size} bytes`,
    image: [...text("RIFF"), size, 0, 0, 0, ...text("WEBP")],
    kept: null,
  })),
  {
    name: "a WebP frame holding another frame, which a decoder draws too",
    image: webp([
      ...vp8x(0x02),
      ...animation,
      ...riffChunk("ANMF", [
        ...place,
        ...lossless,
        ...riffChunk("ANMF", [...place, ...lossy, ...riffChunk("EXIF", cameraExif(6, true))]),
        ...riffChunk("NOTE", text("made up")),
      ]),
    ]),
    kept: webp([
      ...vp8x(0x02),
      ...animation,
      ...riffChunk("ANMF", [...place, ...lossless, ...riffChunk("ANMF", [...place, ...lossy])]),
    ]),
  },
  // Anything else
  { name: "an SVG", image: text("<svg/>"), kept: null },
  { name: "nothing", image: [], kept: null },
];

/** Words the cases plant in metadata, none of which a kept image holds. */
const PLANTED = [
  "made up",
  "Nowhere",
  "Example",
  "Note: made",
  "xmpmeta",
  "Photoshop",
  "Comment",
  "Author",
];

describe("withoutMetadata", () => {
  it.each(CASES)("keeps what draws $name", ({ image, kept }) => {
    expect(hex(withoutMetadata(Uint8Array.from(image)))).toBe(hex(kept));
  });

  it.each(CASES.filter((each) => each.kept !== null))(
    "keeps $name as it is once stripped, with none of the words planted in its metadata",
    ({ kept }) => {
      const once = Uint8Array.from(kept ?? []);
      expect(hex(withoutMetadata(once))).toBe(hex(once));
      const latin1 = Buffer.from(once).toString("latin1");
      expect(PLANTED.filter((word) => latin1.includes(word))).toEqual([]);
    },
  );

  it("covers every kind, kept and refused, and plants a word in every kept kind's metadata", () => {
    const kinds = ["JPEG", "PNG", "GIF", "WebP"];
    for (const kind of kinds) {
      expect(CASES.some((each) => each.name.includes(kind) && each.kept !== null)).toBe(true);
      expect(CASES.some((each) => each.name.includes(kind) && each.kept === null)).toBe(true);
    }
    for (const each of [cameraJpeg, cameraPng, animatedGif, animatedWebp]) {
      const latin1 = Buffer.from(each.image).toString("latin1");
      expect(PLANTED.filter((word) => latin1.includes(word)).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("reads a WebP's frames however deep they nest, each inside the one before", () => {
    for (const depth of [1, 2, 100_000]) {
      const image = nestedFrames(depth);
      const started = performance.now();
      const kept = withoutMetadata(image);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(kept !== null && Buffer.from(kept).equals(image)).toBe(true);
    }
  });

  it("reads bytes that are a view into a larger buffer", () => {
    const buffer = Uint8Array.from([0, 0, ...plainPng, 0]);
    const view = buffer.subarray(2, 2 + plainPng.length);
    expect(hex(withoutMetadata(view))).toBe(hex(plainPng));
    expect(hex(withoutMetadata(Uint8Array.from([0, 0, ...cameraPng.image]).subarray(2)))).toBe(
      hex(cameraPng.kept),
    );
  });

  it("writes every case to apps/ios/fixtures/cases, which BoardKit's port runs", async () => {
    const table = CASES.map((each) => ({
      name: each.name,
      image: Buffer.from(each.image).toString("base64"),
      kept: each.kept === null ? null : Buffer.from(each.kept).toString("base64"),
    }));
    expect(new Set(table.map((each) => each.name)).size).toBe(table.length);
    await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot(
      "../../../apps/ios/fixtures/cases/image-metadata.json",
    );
  });
});

describe("exifOrientation", () => {
  it("reads the orientation in either byte order, and none it can't read as upright", () => {
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      for (const little of [true, false]) {
        expect(exifOrientation(Uint8Array.from(cameraExif(orientation, little)))).toBe(orientation);
      }
    }
    // As a JPEG's segment holds it, after its own header.
    expect(exifOrientation(Uint8Array.from([...exifHeader, ...cameraExif(6, true)]))).toBe(6);
    expect(exifOrientation(Uint8Array.from(cameraExif(9, true)))).toBe(1);
    expect(exifOrientation(Uint8Array.from(cameraExif(0, false)))).toBe(1);
    expect(exifOrientation(Uint8Array.from(cameraExif(6, true).slice(0, 30)))).toBe(1);
    expect(exifOrientation(Uint8Array.from(text("II*")))).toBe(1);
    expect(exifOrientation(new Uint8Array())).toBe(1);
    expect(exifOrientation(orientationOnly(5))).toBe(5);
  });
});

describe("crc32", () => {
  it("checks a PNG's chunks as zlib does", () => {
    expect(crc32(Uint8Array.from(text("123456789")))).toBe(0xcbf43926);
    expect(crc32(Uint8Array.from(text("IEND")))).toBe(0xae426082);
    for (const each of [
      text("eXIf"),
      [...text("eXIf"), ...only(6)],
      zeros(300),
      cameraExif(3, false),
    ]) {
      expect(crc32(Uint8Array.from(each))).toBe(zlibCrc32(Buffer.from(each)));
    }
  });
});
