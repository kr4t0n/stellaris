import { expect, it } from "vitest";
import { z } from "zod";
import indexHtml from "../index.html?raw";
import faviconSvg from "../public/favicon.svg?raw";

const images = import.meta.glob<string>("../public/*.{png,ico}", {
  query: "?inline",
  import: "default",
  eager: true,
});
const manifests = import.meta.glob<string>("../public/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
});
function asset(name: string) {
  const url = images[`../public/${name}`];
  if (url === undefined) throw new Error(`Missing icon: ${name}`);
  return Uint8Array.from(atob(url.split(",")[1] ?? ""), (char) => char.charCodeAt(0));
}
const links = [...indexHtml.matchAll(/<link\b[^>]+>/g)].map((match) =>
  Object.fromEntries(
    [...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]]),
  ),
);

function pngSize(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("IHDR");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return `${header.getUint32(16)}x${header.getUint32(20)}`;
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

it("keeps the SVG linked and the conventional ICO unlinked with correctly sized frames", () => {
  expect(links).toContainEqual(
    expect.objectContaining({
      rel: "icon",
      href: "/favicon.svg",
      sizes: "any",
      type: "image/svg+xml",
    }),
  );
  expect(links).not.toContainEqual(expect.objectContaining({ rel: "icon", href: "/favicon.ico" }));
  const ico = asset("favicon.ico");
  const directory = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  expect(directory.getUint16(0, true)).toBe(0);
  expect(directory.getUint16(2, true)).toBe(1);
  expect(directory.getUint16(4, true)).toBe(3);
  let offset = 6 + 3 * 16;
  for (const [index, size] of [16, 32, 48].entries()) {
    const entry = 6 + index * 16;
    expect(ico[entry]).toBe(size);
    expect(ico[entry + 1]).toBe(size);
    expect(directory.getUint16(entry + 4, true)).toBe(1);
    expect(directory.getUint16(entry + 6, true)).toBe(32);
    expect(directory.getUint32(entry + 12, true)).toBe(offset);
    const length = directory.getUint32(entry + 8, true);
    const frame = ico.subarray(offset, offset + length);
    expect(frame.length).toBe(length);
    expect(pngSize(frame)).toBe(`${size}x${size}`);
    offset += length;
  }
  expect(offset).toBe(ico.length);
  for (const [index, size] of [16, 32].entries()) {
    const entry = 6 + index * 16;
    const start = directory.getUint32(entry + 12, true);
    const end = start + directory.getUint32(entry + 8, true);
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
    .parse(JSON.parse(manifests["../public/manifest.json"] ?? "{}"));
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
