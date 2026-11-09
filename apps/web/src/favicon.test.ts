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
