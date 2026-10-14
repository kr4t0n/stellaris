import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

// Headless Chromium starts with --hide-scrollbars, under which a scrollbar on Working now's list
// would take no room and pass unseen.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("the board's content widens by its edge, stays so in this browser, and a double-click widens it all the way", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeBoard(page);
  await page.goto("/c/general");
  const content = page.getByRole("region", { name: "Board content" });
  const handle = page.getByRole("button", { name: /^Width of the board's content/ });
  const width = async () => (await content.boundingBox())?.width ?? 0;
  expect(await width()).toBe(576);

  // Dragging the edge 200 pixels to the left widens the island by as much.
  const edge = await handle.boundingBox();
  if (edge === null) {
    throw new Error("the edge is not on the page");
  }
  const y = edge.y + edge.height / 2;
  await page.mouse.move(edge.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(edge.x - 100, y);
  await page.mouse.move(edge.x - 196, y);
  await page.mouse.up();
  expect(await width()).toBe(776);

  await page.reload();
  await expect(content).toBeVisible();
  expect(await width()).toBe(776);

  // As wide as it goes is up to the navigator; again, and it is back to the default.
  await handle.dblclick();
  expect(await width()).toBe(1440 - 256 - 48);
  await handle.dblclick();
  expect(await width()).toBe(576);

  // The keyboard moves the edge a step at a time, and Enter widens it all the way.
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect(await width()).toBe(608);
  await page.keyboard.press("Enter");
  expect(await width()).toBe(1136);
});

for (const size of [
  { width: 1440, height: 900, navigatorScrolls: false },
  // The narrowest window the islands fit side by side, short enough that the navigator scrolls.
  { width: 724, height: 600, navigatorScrolls: true },
]) {
  test(`Working now keeps two rows and half a third however many citizens are in a turn, scrolls the rest without a scrollbar of its own, and the navigator under it stays put (${size.width}×${size.height})`, async ({
    page,
  }) => {
    // Each of the five changes in who is working waits up to 3 s for the scheduler's poll, and on a
    // loaded machine the test took 27 to 29 s of the default 30 s.
    test.setTimeout(60_000);
    await page.setViewportSize(size);
    const board = await fakeBoard(page);
    await page.goto("/c/general");
    const navigator = page.getByRole("region", { name: "Board navigator" });
    const section = navigator.getByRole("region", { name: "Working now" });
    const heading = section.getByRole("heading");
    const list = section.locator(":scope > div");
    const rows = section.getByRole("listitem");
    const below = navigator.getByRole("link", { name: /^needs you/ });
    const place = async () => ({
      height: (await section.boundingBox())?.height,
      below: (await below.boundingBox())?.y,
    });
    // Whether a row shows whole inside the section, under its heading, and this far from its edges.
    const shown = async (row: number, inset = 0) => {
      const [box, top, item] = await Promise.all([
        section.boundingBox(),
        heading.boundingBox(),
        rows.nth(row).boundingBox(),
      ]);
      if (box === null || top === null || item === null) {
        throw new Error("the section is not on the page");
      }
      return (
        item.y >= top.y + top.height + inset &&
        item.y + item.height <= box.y + box.height - inset + 0.5
      );
    };
    // How much of a row shows above the list's bottom edge.
    const visible = async (row: number) => {
      const [box, item] = await Promise.all([list.boundingBox(), rows.nth(row).boundingBox()]);
      if (box === null || item === null) {
        throw new Error("the list is not on the page");
      }
      return Math.min(box.y + box.height, item.y + item.height) - item.y;
    };
    // The list as drawn: the room a scrollbar takes beside its rows, whether they overflow it,
    // its height, and which edges fade and how deep, read from its mask's computed gradient.
    const drawn = () =>
      list.evaluate((box) => {
        if (!(box instanceof HTMLElement)) {
          throw new Error("the list is not an HTML element");
        }
        const mask = getComputedStyle(box).maskImage;
        const clear = "rgba(0, 0, 0, 0)";
        const edges =
          mask === "none"
            ? []
            : [
                ...(mask.startsWith(`linear-gradient(${clear}`) ? ["top"] : []),
                ...(mask.endsWith(`${clear})`) ? ["bottom"] : []),
              ];
        return {
          scrollbar: box.offsetWidth - box.clientWidth,
          overflows: box.scrollHeight > box.clientHeight,
          height: box.getBoundingClientRect().height,
          fades: edges,
          depth: Number(/(\d+)px/.exec(mask)?.[1] ?? 0),
        };
      });
    const fades = async () => (await drawn()).fades;

    await expect(section.getByText("Nobody is in a turn.")).toBeVisible();
    const idle = await place();
    const working = async (count: number) => {
      board.setWorking(count, 2);
      await expect(rows).toHaveCount(count, { timeout: 10_000 });
      expect(await place(), `${count} in a turn`).toEqual(idle);
    };

    // Two rows fit, so nothing scrolls and the heading counts nobody running.
    await working(1);
    await working(2);
    await expect(heading).toHaveText(/^Working now2 queued$/);
    expect(await drawn()).toMatchObject({ overflows: false, fades: [] });

    // Three rows: two whole and the top half of the third, fading out at the list's foot, which
    // with the count in the heading says the list scrolls, since it shows no scrollbar.
    await working(3);
    await expect(heading).toHaveText(/3 running · 2 queued$/);
    const row = (await rows.first().boundingBox())?.height ?? 0;
    expect(row).toBeGreaterThan(40);
    const three = await drawn();
    expect(three).toMatchObject({ scrollbar: 0, overflows: true, fades: ["bottom"], depth: 16 });
    expect(three.height).toBeCloseTo(2.5 * row + 4, 1);
    expect(await visible(2)).toBeCloseTo(row / 2 + 2, 1);
    await expect(rows.nth(2)).toBeInViewport({ ratio: 0.5 });
    await expect(rows.nth(2)).not.toBeInViewport({ ratio: 0.6 });
    // The navigator keeps its own scrollbar wherever it scrolls.
    const outer = await section.evaluate((element) => {
      const nav = element.closest("nav");
      if (nav === null) {
        throw new Error("the navigator is not on the page");
      }
      return {
        scrollbar: nav.offsetWidth - nav.clientWidth,
        overflows: nav.scrollHeight > nav.clientHeight,
      };
    });
    expect(outer.overflows).toBe(size.navigatorScrolls);
    expect(outer.scrollbar > 0).toBe(size.navigatorScrolls);

    // Seven rows: the wheel brings the rest into view, and each edge fades while rows lie beyond it.
    await working(7);
    await expect(heading).toHaveText(/7 running · 2 queued$/);
    expect(await shown(1)).toBe(true);
    expect(await shown(2)).toBe(false);
    expect(await drawn()).toMatchObject({ scrollbar: 0, overflows: true, fades: ["bottom"] });
    await rows.first().hover();
    await page.mouse.wheel(0, 1_000);
    await expect.poll(() => shown(6)).toBe(true);
    await expect.poll(fades).toEqual(["top"]);
    await page.mouse.wheel(0, -1_000);
    await expect.poll(() => shown(0)).toBe(true);
    await expect.poll(fades).toEqual(["bottom"]);
    // Tab brings each row into view clear of the edges, as far as the last one.
    await rows.first().getByRole("link").focus();
    for (let next = 1; next < 7; next += 1) {
      await page.keyboard.press("Tab");
      await expect(rows.nth(next).getByRole("link")).toBeFocused();
      await expect.poll(() => shown(next, next < 6 ? 16 : 0)).toBe(true);
      if (next === 3) {
        await expect.poll(fades).toEqual(["top", "bottom"]);
      }
    }
    expect(await place()).toEqual(idle);

    board.setWorking(0);
    await expect(section.getByText("Nobody is in a turn.")).toBeVisible({ timeout: 10_000 });
    expect(await place()).toEqual(idle);
  });
}
