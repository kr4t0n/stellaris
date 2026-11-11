import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const check = process.argv.includes("--check");
const publicDir = new URL("../public/", import.meta.url);
const source = await readFile(new URL("favicon.svg", publicDir), "utf8");
const browser = await chromium.launch();
const outputs = new Map();
try {
  const page = await browser.newPage();
  for (const pixels of [16, 32, 48, 180, 192, 512]) {
    const base64 = await page.evaluate(
      async ({ svg, size }) => {
        const xml = new DOMParser().parseFromString(svg, "image/svg+xml");
        const root = xml.documentElement;
        root.setAttribute("width", String(size));
        root.setAttribute("height", String(size));
        if (size === 180) {
          // Apple supplies the mask; only the touch icon needs square, opaque corners.
          const ground = root.querySelector('rect[fill="url(#ground)"]');
          if (!ground) throw new Error("Missing favicon ground");
          ground.removeAttribute("rx");
        }
        const url = URL.createObjectURL(
          new Blob([new XMLSerializer().serializeToString(xml)], { type: "image/svg+xml" }),
        );
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");
          context.drawImage(image, 0, 0);
          if (
            size === 180 &&
            context
              .getImageData(0, 0, size, size)
              .data.some((value, i) => i % 4 === 3 && value !== 255)
          ) {
            throw new Error("Touch icon must be opaque");
          }
          return canvas.toDataURL("image/png").split(",")[1];
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      { svg: source, size: pixels },
    );
    const name =
      pixels === 180
        ? "apple-touch-icon.png"
        : pixels < 100
          ? `favicon-${pixels}x${pixels}.png`
          : `icon-${pixels}.png`;
    outputs.set(name, Buffer.from(base64, "base64"));
  }
} finally {
  await browser.close();
}

// ICO's directory points at one PNG per size, rendered directly rather than downsampled.
const sizes = [16, 32, 48];
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
const frames = sizes.map((size, index) => {
  const png = outputs.get(`favicon-${size}x${size}.png`);
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
  return png;
});
outputs.set("favicon.ico", Buffer.concat([directory, ...frames]));
outputs.delete("favicon-48x48.png");

if (check) {
  for (const [name, bytes] of outputs) {
    if (!bytes.equals(await readFile(new URL(name, publicDir))))
      throw new Error(`Regenerate ${name}`);
  }
  console.log("All raster icons match favicon.svg.");
} else {
  const outputDir = await mkdtemp(join(tmpdir(), "stellaris-icons-"));
  for (const [name, bytes] of outputs) await writeFile(join(outputDir, name), bytes);
  console.log(outputDir);
}
