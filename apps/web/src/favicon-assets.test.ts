/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import indexHtml from "../index.html?raw";
import faviconSvg from "../public/favicon.svg?raw";

const asset = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url));
const links = [...indexHtml.matchAll(/<link\b[^>]+>/g)].map((match) =>
  Object.fromEntries(
    [...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]]),
  ),
);

function pngSize(bytes: Buffer) {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

it.each([
  ["icon", "favicon-16x16.png", 16],
  ["icon", "favicon-32x32.png", 32],
  ["apple-touch-icon", "apple-touch-icon.png", 180],
])("links %s %s at its real PNG dimensions", (rel, name, size) => {
  const sizes = `${size}x${size}`;
  expect(links).toContainEqual(
    expect.objectContaining({ rel, href: `/${name}`, sizes, type: "image/png" }),
  );
  expect(pngSize(asset(name))).toBe(sizes);
});

it("links an ICO whose directory and embedded PNG frames agree", () => {
  expect(links).toContainEqual(
    expect.objectContaining({ rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" }),
  );
  const ico = asset("favicon.ico");
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(3);
  let offset = 6 + 3 * 16;
  for (const [index, size] of [16, 32, 48].entries()) {
    const entry = 6 + index * 16;
    expect(ico[entry]).toBe(size);
    expect(ico[entry + 1]).toBe(size);
    expect(ico.readUInt16LE(entry + 4)).toBe(1);
    expect(ico.readUInt16LE(entry + 6)).toBe(32);
    expect(ico.readUInt32LE(entry + 12)).toBe(offset);
    const length = ico.readUInt32LE(entry + 8);
    const frame = ico.subarray(offset, offset + length);
    expect(frame.length).toBe(length);
    expect(pngSize(frame)).toBe(`${size}x${size}`);
    offset += length;
  }
  expect(offset).toBe(ico.length);
  for (const [index, size] of [16, 32].entries()) {
    const entry = 6 + index * 16;
    const start = ico.readUInt32LE(entry + 12);
    const end = start + ico.readUInt32LE(entry + 8);
    expect(ico.subarray(start, end)).toEqual(asset(`favicon-${size}x${size}.png`));
  }
});

it("links a named manifest with real icons, source ground colours and browser-default display", () => {
  expect(links).toContainEqual(
    expect.objectContaining({ rel: "manifest", href: "/manifest.json" }),
  );
  const manifest = z
    .object({
      name: z.literal("Stellaris"),
      short_name: z.literal("Stellaris"),
      theme_color: z.string(),
      background_color: z.string(),
      icons: z.array(
        z.object({
          src: z.string(),
          sizes: z.string(),
          type: z.literal("image/png"),
          purpose: z.literal("any"),
        }),
      ),
    })
    .strict()
    .parse(JSON.parse(asset("manifest.json").toString()));
  const ground =
    faviconSvg.match(/<linearGradient id="ground"[\s\S]*?<\/linearGradient>/)?.[0] ?? "";
  expect(ground).toContain(`stop-color="${manifest.theme_color}"`);
  expect(ground).toContain(`stop-color="${manifest.background_color}"`);
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
  for (const icon of manifest.icons) {
    expect(icon.src).toMatch(/^\/[\w-]+\.png$/);
    expect(pngSize(asset(icon.src.slice(1)))).toBe(icon.sizes);
  }
});
