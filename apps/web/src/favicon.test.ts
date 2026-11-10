import { expect, it } from "vitest";
import { z } from "zod";
import iconDocument from "../../ios/Icon/AppIcon.icon/icon.json?raw";
import faviconSvg from "../public/favicon.svg?raw";

const assets = import.meta.glob<string>("../../ios/Icon/AppIcon.icon/Assets/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});
const compact = (svg: string) => svg.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();

it("keeps the favicon's ground in sync with the app icon's Default background", () => {
  const icon = z
    .object({
      "fill-specializations": z.array(
        z.object({ appearance: z.string().optional(), value: z.unknown() }),
      ),
    })
    .parse(JSON.parse(iconDocument));
  const point = z.object({ x: z.number(), y: z.number() });
  const ground = z
    .object({
      "linear-gradient": z.tuple([z.string(), z.string()]),
      orientation: z.object({ start: point, stop: point }),
    })
    .parse(icon["fill-specializations"].find((fill) => fill.appearance === undefined)?.value);
  const stops = ground["linear-gradient"].map((color, offset) => {
    expect(color).toMatch(/^srgb:/);
    const rgba = color.slice(5).split(",").map(Number);
    expect(rgba).toHaveLength(4);
    expect(rgba[3]).toBe(1);
    const hex = rgba
      .slice(0, 3)
      .map((channel) =>
        Math.round(channel * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
    return `<stop offset="${offset}" stop-color="#${hex}"/>`;
  });
  const { start, stop } = ground.orientation;
  expect(compact(faviconSvg)).toContain(
    `<linearGradient id="ground" x1="${start.x * 100}%" y1="${start.y * 100}%" x2="${stop.x * 100}%" y2="${stop.y * 100}%">${stops.join("")}</linearGradient>`,
  );
});

it("keeps the favicon's six layers in sync with the app icon's artwork and opacity", () => {
  const icon = z
    .object({
      groups: z.array(
        z.object({
          layers: z.array(
            z.object({ name: z.string(), "image-name": z.string(), opacity: z.number() }),
          ),
        }),
      ),
    })
    .parse(JSON.parse(iconDocument));
  const favicon = compact(faviconSvg);
  // Icon Composer lists front groups first; SVG paints back to front.
  const layers = icon.groups.toReversed().flatMap((group) => group.layers);
  const expected = layers.map((layer) => {
    const asset = assets[`../../ios/Icon/AppIcon.icon/Assets/${layer["image-name"]}`];
    if (asset === undefined) throw new Error(`Missing icon layer: ${layer["image-name"]}`);
    const artwork = asset.replace(/<svg\b[^>]*>/, "").replace(/<\/svg>/, "");
    return compact(`<g id="${layer.name}" opacity="${layer.opacity}">${artwork}</g>`);
  });

  expect(layers).toHaveLength(6);
  expect(favicon).toContain(expected.join(""));
  const ids = [...favicon.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(favicon).not.toMatch(/<image\b|\bhref=|@import/);
});
