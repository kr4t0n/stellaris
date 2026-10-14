import { describe, expect, it } from "vitest";
import { imageTypeOf, uploadedImageId } from "./images.js";

const bytes = (...parts: Array<string | number[]>): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === "string" ? part.split("").map((char) => char.charCodeAt(0)) : part,
    ),
  );

describe("imageTypeOf", () => {
  it("tells a PNG, a JPEG, a GIF, and a WebP by their first bytes", () => {
    expect(imageTypeOf(bytes([0x89], "PNG\r\n\x1a\n", "\0\0\0\rIHDR"))).toBe("png");
    expect(imageTypeOf(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(imageTypeOf(bytes([0xff, 0xd8, 0xff, 0xdb]))).toBe("jpeg");
    expect(imageTypeOf(bytes("GIF87a", [1, 0]))).toBe("gif");
    expect(imageTypeOf(bytes("GIF89a", [1, 0]))).toBe("gif");
    expect(imageTypeOf(bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "))).toBe("webp");
  });

  it("refuses anything else, however close its first bytes come", () => {
    for (const each of [
      bytes(),
      bytes([0x89], "PNG"),
      bytes([0x89], "PNG\r\n\x1a"),
      bytes([0x89], "PNG\r\n\0\n"),
      bytes([0x88], "PNG\r\n\x1a\n"),
      bytes([0xfe, 0xd8, 0xff, 0xe0]),
      bytes("XIF89a"),
      bytes("XIFF", [0x24, 0, 0, 0], "WEBPVP8 "),
      bytes([0xff, 0xd8]),
      bytes("GIF88a"),
      bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "),
      bytes("RIFF", [0x24, 0, 0], "WEBP"),
      bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      bytes('<?xml version="1.0"?><svg/>'),
      bytes("BM"),
      bytes("\0\0\0\x1cftypavif"),
    ]) {
      expect(imageTypeOf(each)).toBeNull();
    }
  });
});

describe("uploadedImageId", () => {
  it("reads image: followed by an id, and nothing else", () => {
    expect(uploadedImageId("image:01M4WY483E0XG4Q2ZTHAX3JBZV")).toBe("01M4WY483E0XG4Q2ZTHAX3JBZV");
    for (const href of [
      "image:01m4wy483e0xg4q2zthax3jbzv",
      "image:01M4WY483E0XG4Q2ZTHAX3JBZV.png",
      "image:01M4WY483E0XG4Q2ZTHAX3JBZ",
      "image:",
      "images:01M4WY483E0XG4Q2ZTHAX3JBZV",
      "01M4WY483E0XG4Q2ZTHAX3JBZV",
      "https://x.y/image:01M4WY483E0XG4Q2ZTHAX3JBZV",
    ]) {
      expect(uploadedImageId(href)).toBeNull();
    }
  });
});
