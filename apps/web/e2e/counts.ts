import { expect, type Locator, type Page } from "@playwright/test";
import { fakeBoard } from "./board.js";

// The navigator's counts and new-messages dots, and where a row's parts are drawn, for the specs
// that check how they line up.

/**
 * The middle of where part of a row is drawn, in the pixels of the row's screenshot: the rows
 * holding at least half the strongest light, or green, over the ground within the given columns.
 */
export async function drawnMiddle(
  page: Page,
  shot: Buffer,
  columns: { from: number; to: number },
  green = false,
): Promise<number> {
  return page.evaluate(
    async ({ bytes, from, to, byGreen }) => {
      const image = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context?.drawImage(image, 0, 0);
      const data = context?.getImageData(0, 0, image.width, image.height).data ?? [];
      const rows: number[] = [];
      for (let y = 0; y < image.height; y += 1) {
        let strongest = -Infinity;
        for (let x = from; x < to; x += 1) {
          const [red = 0, greenPart = 0, blue = 0] = data.slice(
            (y * image.width + x) * 4,
            (y * image.width + x) * 4 + 3,
          );
          strongest = Math.max(strongest, byGreen ? greenPart - red : red + greenPart + blue);
        }
        rows.push(strongest);
      }
      const ground = Math.min(...rows);
      const peak = Math.max(...rows) - ground;
      const drawn = rows.flatMap((value, y) => (value - ground >= peak / 2 ? [y] : []));
      return ((drawn[0] ?? 0) + (drawn.at(-1) ?? 0) + 1) / 2;
    },
    { bytes: [...shot], ...columns, byGreen: green },
  );
}

/** Every navigator row with a count. */
export const COUNTED = [
  "/needs-you",
  "/proposals",
  "/c/governance",
  "/c/lab/general",
  "/p/lab/tasks",
];

/**
 * The navigator, on a view no row of it stands for so every row shows its idle ground, in a
 * browser that listed the board before lab's general and the society's general had new posts.
 */
export async function navigatorWithDots(page: Page): Promise<Locator> {
  await fakeBoard(page, { unread: true });
  await page.addInitScript(() => {
    localStorage.setItem("stellaris.seen", JSON.stringify({ "*": "1" }));
  });
  await page.goto("/p/lab");
  const navigator = page.getByRole("region", { name: "Board navigator" });
  await expect(
    navigator.locator('a[href="/c/lab/general"]').getByLabel("new messages"),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.load("11px 'Instrument Sans Variable'"));
  return navigator;
}

/** Where a count's pill, its digits and the dot beside it are drawn, in the screenshot's pixels. */
export async function drawnCount(page: Page, row: Locator, scale: number) {
  const count = row.locator("[title]");
  await expect(count).toBeVisible();
  const [box, pill] = await Promise.all([row.boundingBox(), count.boundingBox()]);
  if (box === null || pill === null) {
    throw new Error("the row is not on the page");
  }
  const shot = await row.screenshot();
  const left = pill.x - box.x;
  const span = (from: number, to: number) => ({
    from: Math.round(from * scale),
    to: Math.round(to * scale),
  });
  // The pill's ground in its left padding, and its digits inside the padding.
  const ground = await drawnMiddle(page, shot, span(left + 2, left + 4));
  const digits = await drawnMiddle(page, shot, span(left + 6, left + pill.width - 6));
  const dot = row.getByLabel("new messages");
  const mark = (await dot.count()) === 0 ? null : await dot.boundingBox();
  const green =
    mark === null
      ? null
      : await drawnMiddle(
          page,
          shot,
          span(mark.x - box.x - 1, mark.x - box.x + mark.width + 1),
          true,
        );
  return { ground, digits, green };
}
