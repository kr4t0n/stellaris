import { crc32 } from "node:zlib";

/**
 * Images for tests that post or upload one: each a whole picture of its kind with no metadata,
 * which the board keeps byte for byte, since it keeps an image without its metadata and refuses
 * one that doesn't read to its end.
 */

/** The smallest PNG there is: one transparent pixel. */
export const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** One blue pixel in each kind the board keeps, as ImageMagick 6.9 writes it with `-strip`. */
export const ONE_PIXEL = {
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUzZswgIiSpAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",
    "base64",
  ),
  jpeg: Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AC9UAkf/2Q==",
    "base64",
  ),
  gif: Buffer.from("R0lGODlhAQABAPAAADNmzAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"),
  webp: Buffer.from(
    "UklGRjYAAABXRUJQVlA4ICoAAADQAQCdASoBAAEAAgA0JaACdLoB+AADsAD+7L2P/PTNeYP8nP+3Jl5tsAA=",
    "base64",
  ),
};

/** A PNG chunk of `type` holding `data`, with its CRC. */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, check]);
}

/**
 * The pixel as a PNG of `size` bytes, a second chunk of image data filling it out: every byte of
 * it is a chunk that draws the picture, so the board keeps all of it.
 */
export function pngOfSize(size: number): Buffer {
  const fill = Buffer.alloc(size - PIXEL.length - 12, 7);
  return Buffer.concat([PIXEL.subarray(0, -12), pngChunk("IDAT", fill), PIXEL.subarray(-12)]);
}
