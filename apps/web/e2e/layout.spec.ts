import { expect, type Locator, type Page, test } from "@playwright/test";
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

/** A browser that chose to put the board beside the sky, from the first frame. */
async function besideTheSky(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("stellaris.boardLayout", "beside");
  });
}

/**
 * A browser set to Chrome's Font size "Large", a 20 px root font, with the board where it chose:
 * the app sets no root size, so the browser's scales every rem.
 */
async function atLargeFont(page: Page, layout: "around" | "beside"): Promise<void> {
  await page.addInitScript((chosen) => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.fontSize = "20px";
    });
    localStorage.setItem("stellaris.boardLayout", chosen);
  }, layout);
}

/** Waits for the scene's next two frames, in which it moves its camera to what changed. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

test("a browser that never chose has the board around the sky, and the header's switch puts it beside the sky and back, keeping the open view as it was", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeBoard(page);
  await page.goto("/c/general");
  const navigator = page.getByRole("region", { name: "Board navigator" });
  const content = page.getByRole("region", { name: "Board content" });
  const beside = page.getByRole("button", { name: "Put the board beside the sky", exact: true });
  const around = page.getByRole("button", { name: "Put the board around the sky", exact: true });

  // Around the sky: the navigator island on the left and the content island at the right edge.
  expect(await boxOf(navigator)).toMatchObject({ x: 16, width: 256 });
  expect(await boxOf(content)).toMatchObject({ x: 1440 - 16 - 576, width: 576 });
  await expect(beside).toHaveAttribute("title", "Board beside the sky");
  const draft = content.getByPlaceholder("Message #general");
  await draft.fill("half a thought");

  // Beside the sky: one panel from the left margin, the navigator then the content at the same width.
  await beside.click();
  await expect(around).toBeVisible();
  await expect(around).toHaveAttribute("title", "Board around the sky");
  expect(await boxOf(navigator)).toMatchObject({ x: 16, width: 256 });
  expect(await boxOf(content)).toMatchObject({ x: 16 + 256, width: 576 });
  await expect(page).toHaveURL(/\/c\/general$/);
  // The view stayed mounted, so what was typed is still there.
  await expect(draft).toHaveValue("half a thought");
  expect(await page.evaluate(() => localStorage.getItem("stellaris.boardLayout"))).toBe("beside");

  // The choice outlives a reload, and closing and reopening the board.
  await page.reload();
  expect(await boxOf(content)).toMatchObject({ x: 16 + 256, width: 576 });
  await page.keyboard.press("Escape");
  await expect(content).toHaveCount(0);
  await page.getByRole("button", { name: "Open the board" }).focus();
  await page.keyboard.press("Enter");
  expect(await boxOf(content)).toMatchObject({ x: 16 + 256, width: 576 });

  // From the keyboard, Enter switches back, and focus stays on the switch.
  await around.focus();
  await page.keyboard.press("Enter");
  await expect(beside).toBeFocused();
  expect(await boxOf(content)).toMatchObject({ x: 1440 - 16 - 576, width: 576 });
  expect(await page.evaluate(() => localStorage.getItem("stellaris.boardLayout"))).toBe("around");
});

test("the sky centers in the room the board leaves it, and again when the board switches sides", async ({
  page,
}) => {
  // Without motion the camera lands at once. On the society's general the camera is home, with
  // the core in the middle of the room and desk's seat, the first, at the core's center.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeBoard(page);
  await page.goto("/c/general");
  const navigator = page.getByRole("region", { name: "Board navigator" });
  const content = page.getByRole("region", { name: "Board content" });
  const hint = page.getByRole("button", { name: /to ask$/ });
  const sky = await boxOf(page.locator("canvas"));

  // Around the sky, the room lies between the islands, 16 px clear of each.
  const between = {
    left: (await boxOf(navigator)).x + 256 + 16,
    right: (await boxOf(content)).x - 16,
  };
  const aroundMiddle = (between.left + between.right) / 2;
  expect(aroundMiddle).toBe(560);
  expect(await middle(hint)).toBeCloseTo(aroundMiddle, 0);
  await nextFrames(page);
  await page.mouse.click(aroundMiddle, sky.y + sky.height / 2);
  await expect(page).toHaveURL(/\/citizen\/desk$/);

  // Beside the sky, the room runs from 16 px past the panel to the window's edge.
  await page.goto("/c/general");
  await page.getByRole("button", { name: "Put the board beside the sky", exact: true }).click();
  const panel = await boxOf(content);
  const right = { left: panel.x + panel.width + 16, right: 1440 };
  const besideMiddle = (right.left + right.right) / 2;
  expect(besideMiddle).toBe(1152);
  await expect.poll(() => middle(hint)).toBeCloseTo(besideMiddle, 0);
  await nextFrames(page);
  await page.mouse.click(besideMiddle, sky.y + sky.height / 2);
  await expect(page).toHaveURL(/\/citizen\/desk$/);
});

test("beside the sky, the content's right edge widens it, the width is the one around the sky, and the arrows follow the edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await besideTheSky(page);
  await fakeBoard(page);
  await page.goto("/c/general");
  const content = page.getByRole("region", { name: "Board content" });
  const handle = page.getByRole("button", { name: /^Width of the board's content/ });
  const width = async () => (await content.boundingBox())?.width ?? 0;
  expect(await width()).toBe(576);

  // The handle is on the panel's right edge, and dragging it 200 pixels right widens the content as much.
  const edge = await boxOf(handle);
  expect(edge.x + edge.width).toBe(16 + 256 + 576);
  const y = edge.y + edge.height / 2;
  await page.mouse.move(edge.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 100, y);
  await page.mouse.move(edge.x + 204, y);
  await page.mouse.up();
  expect(await width()).toBe(776);

  // One stored width serves both layouts.
  await page.reload();
  expect(await width()).toBe(776);
  await page.getByRole("button", { name: "Put the board around the sky", exact: true }).click();
  expect(await boxOf(content)).toMatchObject({ x: 1440 - 16 - 776, width: 776 });
  await page.getByRole("button", { name: "Put the board beside the sky", exact: true }).click();
  expect(await width()).toBe(776);

  // As wide as it goes takes the panel to the window's right margin; again, and it is back to the default.
  await handle.dblclick();
  expect(await width()).toBe(1440 - 256 - 32);
  expect((await boxOf(content)).x + (await width())).toBe(1440 - 16);
  await handle.dblclick();
  expect(await width()).toBe(576);

  // The arrow pointing away from the content widens it, the other narrows it, and Enter widens it all the way.
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  expect(await width()).toBe(608);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await width()).toBe(544);
  await page.keyboard.press("Enter");
  expect(await width()).toBe(1152);
});

for (const size of [
  { width: 1440, height: 900 },
  // Under 1300 the room between the islands is too narrow for the box, but not the room beside the panel.
  { width: 1245, height: 800 },
  { width: 1024, height: 768 },
]) {
  test(`beside the sky, the ask box and its hint keep to the middle of the sky's room (${size.width}×${size.height})`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await besideTheSky(page);
    await fakeBoard(page);
    await page.goto("/c/general");
    const content = await boxOf(page.getByRole("region", { name: "Board content" }));
    const room = { left: content.x + content.width + 16, right: size.width };
    const roomMiddle = (room.left + room.right) / 2;
    expect(await middle(page.getByRole("button", { name: /to ask$/ }))).toBeCloseTo(roomMiddle, 0);

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.keyboard.press("Space");
    const ask = await boxOf(page.getByRole("region", { name: "Ask", exact: true }));
    expect(ask.x).toBeGreaterThanOrEqual(room.left + 16);
    expect(ask.x + ask.width).toBeLessThanOrEqual(room.right - 16);
    expect(ask.x + ask.width / 2).toBeCloseTo(roomMiddle, 0);
  });
}

test("at a 20 px root font, around the sky, the sky centers between the islands, and the widest content stops 16 px short of the navigator", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await atLargeFont(page, "around");
  await fakeBoard(page);
  await page.goto("/c/general");
  const navigator = page.getByRole("region", { name: "Board navigator" });
  const content = page.getByRole("region", { name: "Board content" });
  await expect(content).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
    "20px",
  );
  const sky = await boxOf(page.locator("canvas"));

  // The room lies between the islands as drawn, 16 px clear of each, and the sky's middle is its.
  const nav = await boxOf(navigator);
  const between = { left: nav.x + nav.width + 16, right: (await boxOf(content)).x - 16 };
  const roomMiddle = (between.left + between.right) / 2;
  expect(await middle(page.getByRole("button", { name: /to ask$/ }))).toBeCloseTo(roomMiddle, 0);
  await nextFrames(page);
  await page.mouse.click(roomMiddle, sky.y + sky.height / 2);
  await expect(page).toHaveURL(/\/citizen\/desk$/);
  // The islands keep the places and sizes they have at a 16 px root, 72 px from the top and 16 from the foot.
  await page.goto("/c/general");
  expect(await boxOf(navigator)).toMatchObject({ x: 16, width: 256, y: 72, height: 900 - 88 });
  expect(await boxOf(content)).toMatchObject({
    x: 1440 - 16 - 576,
    width: 576,
    y: 72,
    height: 900 - 88,
  });

  // As wide as it goes, the content keeps the usual gap to the navigator.
  await page.getByRole("button", { name: /^Width of the board's content/ }).dblclick();
  const widest = await boxOf(content);
  expect(widest.x - (nav.x + nav.width)).toBe(16);
  expect(widest).toMatchObject({
    x: 16 + 256 + 16,
    width: 1440 - 256 - 48,
    y: 72,
    height: 900 - 88,
  });
});

for (const window of [1024, 1440]) {
  test(`at a 20 px root font, beside the sky, the content is as wide as chosen, or as the default, beside the navigator (${window} px window)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: window, height: 768 });
    await atLargeFont(page, "beside");
    await fakeBoard(page);
    await page.goto("/c/general");
    const navigator = page.getByRole("region", { name: "Board navigator" });
    const content = page.getByRole("region", { name: "Board content" });
    await expect(content).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
      "20px",
    );
    // Two fifths of the window, 420 at the least.
    const fallback = Math.max(420, Math.round(window * 0.4));
    expect((await boxOf(content)).width).toBe(fallback);
    // The panel's top and foot are 72 and 16 px from the window's, as at a 16 px root.
    expect(await boxOf(navigator)).toMatchObject({ x: 16, width: 256, y: 72, height: 768 - 88 });
    expect(await boxOf(content)).toMatchObject({ x: 16 + 256, y: 72, height: 768 - 88 });

    // The narrowest width a browser can choose.
    await page.evaluate(() => localStorage.setItem("stellaris.contentWidth", "420"));
    await page.reload();
    await expect(content).toBeVisible();
    expect((await boxOf(content)).width).toBe(420);
    expect((await boxOf(content)).x).toBe(16 + 256);
  });
}

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

/**
 * The middle of where part of a row is drawn, in pixels from the top of the row's screenshot at
 * the window's scale of 1: the rows holding at least half the strongest light over the ground
 * within the given columns.
 */
async function drawnMiddle(
  page: Page,
  shot: Buffer,
  columns: { from: number; to: number },
): Promise<number> {
  return page.evaluate(
    async ({ bytes, from, to }) => {
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
          const [red = 0, green = 0, blue = 0] = data.slice(
            (y * image.width + x) * 4,
            (y * image.width + x) * 4 + 3,
          );
          strongest = Math.max(strongest, red + green + blue);
        }
        rows.push(strongest);
      }
      const ground = Math.min(...rows);
      const peak = Math.max(...rows) - ground;
      const drawn = rows.flatMap((value, y) => (value - ground >= peak / 2 ? [y] : []));
      return ((drawn[0] ?? 0) + (drawn.at(-1) ?? 0) + 1) / 2;
    },
    { bytes: [...shot], ...columns },
  );
}

/** Every navigator row with a count. */
const COUNTED = ["/needs-you", "/proposals", "/c/governance", "/c/lab/general", "/p/lab/tasks"];

/**
 * The navigator, on a view no row of it stands for so every row shows its idle ground, in a
 * browser that listed the board before lab's general and the society's general had new posts.
 */
async function unreadNavigator(page: Page): Promise<Locator> {
  await fakeBoard(page, { unread: true });
  await page.addInitScript(() => {
    localStorage.setItem("stellaris.seen", JSON.stringify({ "*": "1" }));
  });
  await page.goto("/p/lab");
  const navigator = page.getByRole("region", { name: "Board navigator" });
  await expect(navigator.locator('a[href="/c/lab/general"] [title]')).toBeVisible();
  await page.evaluate(() => document.fonts.load("11px 'Instrument Sans Variable'"));
  return navigator;
}

/** A box that must be on the page. */
async function boxOf(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) {
    throw new Error("not on the page");
  }
  return found;
}

/** Where a box's middle is across the page. */
async function middle(locator: Locator) {
  const found = await boxOf(locator);
  return found.x + found.width / 2;
}

/** The weight a row's name is drawn in. */
async function nameWeight(row: Locator) {
  return row.locator(".truncate").evaluate((name) => getComputedStyle(name).fontWeight);
}

test("every count in the navigator draws its digits in the middle of its pill", async ({
  page,
}) => {
  const navigator = await unreadNavigator(page);
  for (const href of COUNTED) {
    const row = navigator.locator(`a[href="${href}"]`);
    const [box, pill] = await Promise.all([boxOf(row), boxOf(row.locator("[title]"))]);
    const shot = await row.screenshot();
    const left = pill.x - box.x;
    // The pill's ground in its left padding, and its digits inside the padding.
    const ground = await drawnMiddle(page, shot, {
      from: Math.round(left + 2),
      to: Math.round(left + 4),
    });
    const digits = await drawnMiddle(page, shot, {
      from: Math.round(left + 6),
      to: Math.round(left + pill.width - 6),
    });
    // On the row's own line Chromium draws the digits a whole pixel above the pill's middle, the
    // smallest step they can be off by at this scale. Half a pixel is left for a shape of odd
    // height, whose middle falls between rows.
    expect(
      Math.abs(digits - ground),
      `${href}: digits ${digits}, pill ${ground}`,
    ).toBeLessThanOrEqual(0.5);
  }
});

test("every count in the navigator is centred on one vertical line, whatever its width", async ({
  page,
}) => {
  const navigator = await unreadNavigator(page);
  // needs you's 2, governance's 13 and the 1s are pills of three widths.
  const middles = await Promise.all(
    COUNTED.map((href) => middle(navigator.locator(`a[href="${href}"] [title]`))),
  );
  expect(new Set(middles), `middles ${JSON.stringify(middles)}`).toEqual(new Set([middles[0]]));
});

test("a channel with posts this browser hasn't seen shows its name in bold and no dot, and tells a screen reader it has new messages", async ({
  page,
}) => {
  const navigator = await unreadNavigator(page);
  for (const href of ["/c/general", "/c/lab/general"]) {
    const row = navigator.locator(`a[href="${href}"]`);
    await expect(row).toHaveAccessibleName(/new messages/);
    await expect(row.locator('[aria-label="new messages"]')).toHaveCount(0);
    expect(await nameWeight(row), href).toBe("600");
  }
  // A channel read to its end shows neither.
  const read = navigator.locator('a[href="/c/governance"]');
  await expect(read).not.toHaveAccessibleName(/new messages/);
  expect(await nameWeight(read)).toBe("400");
});

/** How far `main` could scroll sideways: it hides its overflow, but focus still scrolls it. */
async function hiddenOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    return main === null ? -1 : main.scrollWidth - main.clientWidth;
  });
}

/** Whether two boxes share any area. */
function overlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The ask hint's key and words, which run on past its box when the box is squashed. */
async function hintText(page: Page) {
  const hint = page.getByRole("button", { name: /to ask$/ });
  await expect(hint).toBeVisible();
  return hint.evaluate((button) => {
    const parts = [...button.children].map((part) => part.getBoundingClientRect());
    const left = Math.min(...parts.map((part) => part.left));
    const top = Math.min(...parts.map((part) => part.top));
    return {
      x: left,
      y: top,
      width: Math.max(...parts.map((part) => part.right)) - left,
      height: Math.max(...parts.map((part) => part.bottom)) - top,
    };
  });
}

/**
 * Beside the sky in a window `width` wide: nothing hidden for `main` to scroll; the panel 16 px in
 * from the window's edges; Send inside the window; the hint whole on screen, clear of the panel and
 * of the camera's buttons, or, where the sky beside the panel is too narrow for it, left out, with
 * Space still opening the ask box inside the window; and each control the user needs, focused as
 * Tab would, inside the window, with nothing moving the scene.
 */
async function fitsBeside(page: Page, width: number, height: number, hint: boolean) {
  const content = page.getByRole("region", { name: "Board content" });
  const send = content.getByRole("button", { name: "Send" });
  await expect(send).toBeVisible();
  expect(await hiddenOverflow(page)).toBe(0);
  const panel = await boxOf(content.locator("xpath=.."));
  expect(panel.x).toBe(16);
  expect(panel.x + panel.width).toBeLessThanOrEqual(width - 16);
  expect(panel).toMatchObject({ y: 72, height: height - 88 });
  const inside = (box: { x: number; width: number }) => {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  };
  inside(await boxOf(send));

  const camera = page.getByRole("group", { name: "Camera" });
  const buttons = (await camera.isVisible()) ? await boxOf(camera) : null;
  if (buttons !== null) {
    inside(buttons);
    expect(overlap(buttons, panel)).toBe(false);
    // Nothing lies over them: a press on the middle of Fit reaches Fit.
    const fit = await boxOf(page.getByRole("button", { name: "Fit the whole sky" }));
    const reached = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"),
      { x: fit.x + fit.width / 2, y: fit.y + fit.height / 2 },
    );
    expect(reached).toBe("Fit the whole sky");
  }
  const hintButton = page.getByRole("button", { name: /to ask$/ });
  if (hint) {
    const text = await hintText(page);
    inside(text);
    expect(overlap(text, panel)).toBe(false);
    expect(buttons === null || !overlap(text, buttons)).toBe(true);
  } else {
    await expect(hintButton).toHaveCount(0);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.keyboard.press("Space");
    const ask = page.getByRole("region", { name: "Ask", exact: true });
    inside(await boxOf(ask));
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
  }

  for (const control of [
    send,
    page.getByRole("button", { name: /^Width of the board's content/ }),
    page.getByRole("link", { name: "Close the board" }),
    page.getByRole("button", { name: "Put the board around the sky", exact: true }),
    ...(hint ? [hintButton] : []),
  ]) {
    await control.focus();
    inside(await boxOf(control));
    expect(await page.evaluate(() => document.querySelector("main")?.scrollLeft)).toBe(0);
  }
}

for (const width of [320, 360, 480, 600, 700, 707]) {
  test(`beside the sky in a ${width} px window, the navigator folds to its rail, the panel and Send stay inside the window, and the hint is left out`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await besideTheSky(page);
    await fakeBoard(page);
    await page.goto("/c/general");
    // The sky beside the panel is under 232 px, too narrow for the hint.
    await fitsBeside(page, width, 800, false);
    // The rail, then the content: 420 px while the window holds it, and what is left once it doesn't.
    const rail = page.getByRole("region", { name: "Board", exact: true });
    await expect(page.getByRole("region", { name: "Board navigator" })).toHaveCount(0);
    expect((await boxOf(rail)).width).toBe(44);
    expect(await boxOf(page.getByRole("region", { name: "Board content" }))).toMatchObject({
      x: 16 + 44,
      width: Math.min(420, width - 32 - 44),
    });
    await page.getByRole("button", { name: "Show the board's channels" }).focus();
    expect(await page.evaluate(() => document.querySelector("main")?.scrollLeft)).toBe(0);
  });
}

for (const width of [360, 600]) {
  test(`at a 20 px root font, beside the sky in a ${width} px window, the panel and Send stay inside the window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await atLargeFont(page, "beside");
    await fakeBoard(page);
    await page.goto("/c/general");
    await expect(page.getByRole("region", { name: "Board content" })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
      "20px",
    );
    await fitsBeside(page, width, 800, false);
    await expect(page.getByRole("region", { name: "Board", exact: true })).toBeVisible();
  });
}

for (const width of [708, 783, 800, 1024, 1440]) {
  test(`beside the sky at its widest in a ${width} px window, the panel leaves no sky beside it, so the hint is left out and nothing lies past the window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await besideTheSky(page);
    await page.addInitScript(() => {
      localStorage.setItem("stellaris.contentWidth", "widest");
    });
    await fakeBoard(page);
    await page.goto("/c/general");
    const content = page.getByRole("region", { name: "Board content" });
    await expect(page.getByRole("region", { name: "Board navigator" })).toBeVisible();
    await expect(content).toBeVisible();
    expect((await boxOf(content.locator("xpath=.."))).width).toBe(width - 32);
    await fitsBeside(page, width, 800, false);
  });
}

test("beside the sky at the default width, the hint shows once the sky beside the panel holds it, and in its middle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 987, height: 800 });
  await besideTheSky(page);
  await fakeBoard(page);
  await page.goto("/c/general");
  await fitsBeside(page, 987, 800, false);
  // At 988 px the sky beside the panel is 280 px.
  await page.setViewportSize({ width: 988, height: 800 });
  await expect(page.getByRole("button", { name: /to ask$/ })).toBeVisible();
  await fitsBeside(page, 988, 800, true);
  const hint = await hintText(page);
  expect(hint.x + hint.width / 2).toBeCloseTo((708 + 988) / 2, 0);
});

for (const { root, width } of [
  // The narrowest window that shows the hint at each root, and wider ones at 16 px.
  { root: 16, width: 988 },
  { root: 16, width: 1024 },
  { root: 16, width: 1215 },
  { root: 12, width: 926 },
  { root: 20, width: 1050 },
  { root: 24, width: 1153 },
]) {
  test(`beside the sky in a ${width} px window at a ${root} px root font, an unread answer widens the hint only as far as it stays clear of the camera's buttons`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript((size) => {
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.fontSize = `${size}px`;
      });
      localStorage.setItem("stellaris.boardLayout", "beside");
    }, root);
    await fakeBoard(page, { asks: true });
    await page.goto("/c/general");
    await expect(page.getByRole("button", { name: /answered .* to ask$/ })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
      `${root}px`,
    );
    await fitsBeside(page, width, 800, true);
  });
}

test("the rail's channels open over the view, and close on Escape, on the button again, on a choice, and on a press beside them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await besideTheSky(page);
  await fakeBoard(page);
  await page.goto("/c/general");
  const content = page.getByRole("region", { name: "Board content" });
  const box = content.getByRole("textbox", { name: "Message #general" });
  await box.fill("a draft");
  const channels = page.getByRole("button", { name: "Show the board's channels" });
  const navigator = page.getByRole("region", { name: "Board navigator" });
  await expect(channels).toHaveAttribute("aria-expanded", "false");

  // Open: the navigator lies over the view, beside the rail, and the view keeps what was typed.
  await channels.click();
  await expect(navigator).toBeVisible();
  await expect(channels).toHaveAttribute("aria-expanded", "true");
  const over = await boxOf(navigator);
  expect(over).toMatchObject({ x: 16 + 44, width: 256 });
  expect(overlap(over, await boxOf(content))).toBe(true);
  // Its header leaves the switch and Close to the rail.
  await expect(page.getByRole("link", { name: "Close the board" })).toHaveCount(1);

  // Escape closes the channels and leaves the board open, with the focus back on their button.
  await navigator.getByRole("link", { name: /^needs you/ }).focus();
  await page.keyboard.press("Escape");
  await expect(navigator).toHaveCount(0);
  await expect(page).toHaveURL(/\/c\/general$/);
  await expect(channels).toBeFocused();
  await expect(box).toHaveValue("a draft");

  // The button again.
  await channels.click();
  await expect(navigator).toBeVisible();
  await channels.click();
  await expect(navigator).toHaveCount(0);

  // A press on the view beside them.
  await channels.click();
  await expect(navigator).toBeVisible();
  const view = await boxOf(content);
  await page.mouse.click(view.x + view.width - 20, view.y + view.height / 2);
  await expect(navigator).toHaveCount(0);

  // Choosing the open channel again closes them where they are.
  await channels.click();
  await navigator
    .getByRole("link", { name: /^#?\s*general/ })
    .first()
    .click();
  await expect(navigator).toHaveCount(0);
  await expect(page).toHaveURL(/\/c\/general$/);

  // Choosing another opens it, and the channels close.
  await channels.click();
  await navigator.getByRole("link", { name: /^needs you/ }).click();
  await expect(page).toHaveURL(/\/needs-you$/);
  await expect(navigator).toHaveCount(0);

  // With the channels closed, Escape closes the board.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/$/);
});

test("a window narrowing past 708 px beside the sky folds the navigator and keeps the open view, and widening brings the navigator back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await besideTheSky(page);
  await fakeBoard(page);
  await page.goto("/c/general");
  const box = page.getByRole("textbox", { name: "Message #general" });
  await box.fill("a draft");
  const rail = page.getByRole("region", { name: "Board", exact: true });
  const navigator = page.getByRole("region", { name: "Board navigator" });
  await expect(navigator).toBeVisible();
  await expect(rail).toHaveCount(0);

  await page.setViewportSize({ width: 707, height: 800 });
  await expect(rail).toBeVisible();
  await expect(navigator).toHaveCount(0);
  await expect(box).toHaveValue("a draft");

  await page.setViewportSize({ width: 708, height: 800 });
  await expect(navigator).toBeVisible();
  await expect(rail).toHaveCount(0);
  await expect(box).toHaveValue("a draft");
});

test("Tab past the rail's open channels closes them, so the focus never goes to what they cover", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await besideTheSky(page);
  await fakeBoard(page);
  await page.goto("/c/general");
  const channels = page.getByRole("button", { name: "Show the board's channels" });
  const navigator = page.getByRole("region", { name: "Board navigator" });
  await channels.focus();
  await page.keyboard.press("Enter");
  await expect(navigator).toBeVisible();
  // Tab walks the list, which stays open while the focus is in it.
  await page.keyboard.press("Tab");
  await expect(navigator).toBeVisible();
  const inList = () =>
    page.evaluate(() =>
      Boolean(document.activeElement?.closest('section[aria-label="Board navigator"]')),
    );
  expect(await inList()).toBe(true);
  for (let step = 0; step < 60 && (await inList()); step += 1) {
    await page.keyboard.press("Tab");
  }
  // Past its last link, the focus is on the rail's next button, and the list is closed.
  await expect(navigator).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Put the board around the sky", exact: true }),
  ).toBeFocused();
  await expect(channels).toHaveAttribute("aria-expanded", "false");
});

test("the rail's channels, left open as the window widens past 708 px, are closed when it narrows again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await besideTheSky(page);
  await fakeBoard(page);
  await page.goto("/c/general");
  const channels = page.getByRole("button", { name: "Show the board's channels" });
  await channels.click();
  await expect(page.getByRole("region", { name: "Board navigator" })).toBeVisible();
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.getByRole("region", { name: "Board", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(channels).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: "Board navigator" })).toHaveCount(0);
});

for (const stored of [null, "600"]) {
  test(`a handle that can't move in a narrow window keeps the width this browser chose (${stored ?? "none"})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await besideTheSky(page);
    if (stored !== null) {
      await page.addInitScript((chosen) => {
        localStorage.setItem("stellaris.contentWidth", chosen);
      }, stored);
    }
    await fakeBoard(page);
    await page.goto("/c/general");
    const handle = page.getByRole("button", { name: /^Width of the board's content/ });
    await handle.focus();
    for (const key of ["ArrowRight", "ArrowLeft", "End", "Home"]) {
      await page.keyboard.press(key);
    }
    // A drag that ends where it began, as the handle can't move here.
    const edge = await boxOf(handle);
    await page.mouse.move(edge.x + 4, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + 120, edge.y + edge.height / 2);
    await page.mouse.up();
    expect(await page.evaluate(() => localStorage.getItem("stellaris.contentWidth"))).toBe(stored);
    // A wide window then gives the content the default, or the width chosen.
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect
      .poll(async () => (await boxOf(page.getByRole("region", { name: "Board content" }))).width)
      .toBe(stored === null ? 576 : 600);
  });
}
