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
  await page.getByRole("button", { name: "Board", exact: true }).click();
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

test("beside the sky, the operations log shows whole over the sky's corner, in front of the panel where they meet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await besideTheSky(page);
  await fakeBoard(page);
  await page.goto("/c/general");
  const content = await boxOf(page.getByRole("region", { name: "Board content" }));
  await page.getByRole("button", { name: "Logs" }).click();
  const log = page.getByRole("region", { name: "Operations log" });
  const box = await boxOf(log);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1024 - 16);
  expect(box.y + box.height).toBeLessThanOrEqual(768);
  // At this width the log reaches over the panel's right edge, and is drawn in front of it there.
  expect(box.x).toBeLessThan(content.x + content.width);
  const front = await log.evaluate(
    (element, at) => element.contains(document.elementFromPoint(at.x, at.y)),
    { x: (box.x + content.x + content.width) / 2, y: box.y + 24 },
  );
  expect(front).toBe(true);
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
