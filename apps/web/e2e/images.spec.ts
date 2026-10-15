import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  BADGE_TARGET,
  fakeBoard,
  MISSING_IMAGE,
  PHONE_SIZE,
  SCREENSHOT_SIZE,
  SKILL_PROPOSAL,
  STAGE_TASK,
  TOKEN,
  UPLOADED_IMAGE,
} from "./board.js";

test("an image a citizen uploaded shows in its post, read with the board's token, and an unknown one reads as its description", async ({
  page,
}) => {
  const asked: Array<{ path: string; authorization: string | undefined }> = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/images/")) {
      asked.push({ path: pathname, authorization: request.headers()["authorization"] });
    }
  });
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);

  const thread = page.getByRole("region", { name: "Board content" }).getByRole("region", {
    name: "Thread",
  });
  const before = thread.getByRole("img", { name: "The survey page, before" });
  await expect(before).toBeVisible();
  await expect
    .poll(() => before.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(SCREENSHOT_SIZE.width);
  await expect(before).toHaveAttribute("src", /^data:image\/png;base64,/);

  // The board has no such image: the post keeps its words, with the board's reason on hover.
  const after = thread.getByText("The survey page, after", { exact: true });
  await expect(after).toBeVisible();
  await expect(after).toHaveAttribute("title", "image not found");
  await expect(thread.getByRole("img", { name: "The survey page, after" })).toHaveCount(0);
  await expect(thread).toContainText("The survey page before the change:");

  expect(asked).toContainEqual({
    path: `/api/images/${UPLOADED_IMAGE}`,
    authorization: `Bearer ${TOKEN}`,
  });
  // An unknown image is asked for once, not again and again.
  expect(asked.filter((each) => each.path === `/api/images/${MISSING_IMAGE}`)).toHaveLength(1);
});

/** The task's thread in the content island. */
function taskThread(page: Page): Locator {
  return page
    .getByRole("region", { name: "Board content" })
    .getByRole("region", { name: "Thread" });
}

/** A box on screen, once its element shows. */
async function boxOf(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box ?? { x: 0, y: 0, width: 0, height: 0 };
}

/** Whether the element at a point of the window is inside the enlarged image's dialog. */
function dialogAt(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ([px, py]) => document.elementFromPoint(px ?? 0, py ?? 0)?.closest("dialog") != null,
    [x, y],
  );
}

/** The enlarged image fills what the window leaves, at its own shape, and no larger than it is. */
async function expectFitted(page: Page, image: Locator, size: { width: number; height: number }) {
  const window = page.viewportSize() ?? { width: 0, height: 0 };
  const box = await boxOf(image);
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.y).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(window.width - 16);
  expect(box.y + box.height).toBeLessThanOrEqual(window.height - 16);
  expect(box.width / box.height).toBeCloseTo(size.width / size.height, 2);
  expect(box.width).toBeLessThanOrEqual(size.width);
  return box;
}

test("a click enlarges an uploaded image over the whole window, fitted to it, and Escape, a click, or Close puts it away", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);

  const enlarge = taskThread(page).getByRole("button", { name: "Enlarge The survey page, before" });
  const image = enlarge.locator("img");
  await expect(image).toHaveCSS("cursor", "zoom-in");
  const inline = await boxOf(image);
  const dialog = page.getByRole("dialog", { name: "The survey page, before" });
  const enlarged = dialog.getByRole("img", { name: "The survey page, before" });

  await image.click();
  // Over the whole window, not only the content island it was opened from, in the body rather
  // than the post's paragraph, with the board dimmed behind it.
  expect(await boxOf(dialog)).toEqual({ x: 0, y: 0, width: 1600, height: 1000 });
  expect(await dialog.evaluate((element) => element.parentElement === document.body)).toBe(true);
  expect(
    await dialog.evaluate((element) => getComputedStyle(element, "::backdrop").backgroundColor),
  ).toBe("oklab(0 0 0 / 0.85)");
  const island = await boxOf(page.getByRole("region", { name: "Board content" }));
  expect(island.x).toBeGreaterThan(8);
  expect(await dialogAt(page, 8, 8)).toBe(true);
  expect(await dialogAt(page, island.x - 8, 500)).toBe(true);
  const box = await expectFitted(page, enlarged, SCREENSHOT_SIZE);
  expect(box.width).toBeGreaterThan(inline.width * 2);
  expect(box.height).toBeGreaterThan(inline.height * 2);
  // In a window larger than the image, it shows at its own size, never stretched past it.
  await page.setViewportSize({ width: 2000, height: 1300 });
  expect(await boxOf(enlarged)).toMatchObject(SCREENSHOT_SIZE);
  await page.setViewportSize({ width: 1600, height: 1000 });

  // Escape closes the image alone: the board stays where it was.
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/task/${STAGE_TASK}$`));

  // A click beside the image, where the board shows dimmed.
  await image.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(8, 500);
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();

  await image.click();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();

  await image.click();
  await enlarged.click();
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();

  // Space while the image is open closes it, rather than opening the ask box behind it.
  const ask = page.getByRole("region", { name: "Ask", exact: true });
  await image.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press(" ");
  await expect(dialog).toHaveCount(0);
  await expect(ask).toHaveCount(0);
  await expect(enlarge).toBeFocused();

  // Tab inside the open image counts as the keyboard's, so after Escape, Space presses the image
  // again rather than opening the ask box.
  await image.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();
  await page.keyboard.press(" ");
  await expect(dialog).toBeVisible();
  await expect(ask).toHaveCount(0);
});

test("the keyboard enlarges an image with Enter, or Space once Tab reached it", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const enlarge = taskThread(page).getByRole("button", { name: "Enlarge The survey page, before" });
  const dialog = page.getByRole("dialog", { name: "The survey page, before" });

  await enlarge.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();

  // Focus comes back to the image even when the click that opened it did not focus it, as a
  // click on a button does not in Safari; the browser alone would give it back to the page.
  await enlarge.blur();
  await enlarge.dispatchEvent("click");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(enlarge).toBeFocused();
  // The focus ring goes round the image, not the button, which is as wide as the post.
  await expect(enlarge.locator("img")).not.toHaveCSS("box-shadow", "none");
  await page.keyboard.press(" ");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("region", { name: "Ask", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();

  // Space straight after Escape opens it again: the close is done before the next key.
  await page.keyboard.press(" ");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press(" ");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
});

test("an image the board does not have stays its description, with nothing to enlarge", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const thread = taskThread(page);
  await expect(
    thread.getByRole("button", { name: "Enlarge The survey page, before" }),
  ).toBeVisible();

  const after = thread.getByText("The survey page, after", { exact: true });
  await expect(after).toHaveCSS("cursor", "auto");
  await expect(thread.getByRole("button", { name: /The survey page, after/ })).toHaveCount(0);
  await after.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an image on the web enlarges too, to the window's height when it is tall", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const enlarge = taskThread(page).getByRole("button", {
    name: "Enlarge The survey page on a phone",
  });
  await expect
    .poll(() => enlarge.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(PHONE_SIZE.width);
  const inline = await boxOf(enlarge.locator("img"));
  // It takes a line of its own, as every image in a post does, rather than following the words.
  const before = await boxOf(
    taskThread(page).getByRole("img", { name: "The survey page, before" }),
  );
  expect(inline.x).toBe(before.x);
  // Narrower than the post: a click in the space beside it opens nothing.
  await page.mouse.click(inline.x + inline.width + 40, inline.y + inline.height / 2);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await enlarge.locator("img").click();
  const dialog = page.getByRole("dialog", { name: "The survey page on a phone" });
  const box = await expectFitted(page, dialog.getByRole("img"), PHONE_SIZE);
  expect(box.height).toBeGreaterThan(inline.height);
  expect(box.height).toBeGreaterThan(1000 - 100);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();
});

for (const place of [
  { view: "a task's thread", path: `/task/${STAGE_TASK}`, name: "The survey page, before" },
  { view: "a thread", path: `/thread/${STAGE_TASK}`, name: "The survey page, before" },
  { view: "a channel", path: "/c/lab/general", name: "The survey page in lab" },
]) {
  for (const window of [
    { width: 1280, height: 720 },
    { width: 480, height: 800 },
  ]) {
    test(`an image enlarges over the whole window from ${place.view}, ${window.width} wide`, async ({
      page,
    }) => {
      await page.setViewportSize(window);
      await fakeBoard(page, { uploads: true });
      await page.goto(place.path);
      const enlarge = page
        .getByRole("region", { name: "Board content" })
        .getByRole("button", { name: `Enlarge ${place.name}` });
      const inline = await boxOf(enlarge.locator("img"));

      await enlarge.locator("img").click();
      const dialog = page.getByRole("dialog", { name: place.name });
      expect(await boxOf(dialog)).toEqual({ x: 0, y: 0, ...window });
      const box = await expectFitted(page, dialog.getByRole("img"), SCREENSHOT_SIZE);
      expect(box.width).toBeGreaterThan(inline.width);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(enlarge).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`${place.path}$`));
    });
  }
}

test("an image inside a link opens the link alone, as a plain image", async ({ page }) => {
  await page
    .context()
    .route(`${BADGE_TARGET}**`, (route) => route.fulfill({ contentType: "text/plain", body: "" }));
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const link = taskThread(page).getByRole("link", { name: "The badge" });
  await expect(link.getByRole("img", { name: "The badge" })).toBeVisible();
  await expect(link.locator("button")).toHaveCount(0);

  const popup = page.waitForEvent("popup");
  await link.getByRole("img", { name: "The badge" }).click();
  await (await popup).waitForURL(BADGE_TARGET);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // So does one inside a link to something on the board or to a file on a task's branch.
  for (const name of ["The proposal's mark", "The report's mark"]) {
    const boardLink = taskThread(page).getByRole("link", { name });
    await expect(boardLink.getByRole("img", { name })).toBeVisible();
    await expect(boardLink.locator("button")).toHaveCount(0);
  }
  await taskThread(page).getByRole("img", { name: "The proposal's mark" }).click();
  await expect(page).toHaveURL(new RegExp(`/proposal/${SKILL_PROPOSAL}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a vector with no size of its own shows as wide as the post, and enlarges to the window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const thread = taskThread(page);
  const enlarge = thread.getByRole("button", { name: "Enlarge The vector picture" });
  const inline = await boxOf(enlarge.locator("img"));
  const before = await boxOf(thread.getByRole("img", { name: "The survey page, before" }));
  expect(inline.width).toBe(before.width);
  expect(inline.width / inline.height).toBeCloseTo(2, 2);

  await enlarge.locator("img").click();
  const enlarged = await boxOf(
    page.getByRole("dialog", { name: "The vector picture" }).getByRole("img"),
  );
  expect(enlarged.width).toBeGreaterThan(inline.width * 2);
  expect(enlarged.width / enlarged.height).toBeCloseTo(2, 2);
  expect(enlarged.x).toBeGreaterThanOrEqual(16);
  expect(enlarged.x + enlarged.width).toBeLessThanOrEqual(1600 - 16);
});

test("a web image that fails to load stays a plain image, with nothing to enlarge", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const thread = taskThread(page);
  await expect(thread.getByRole("img", { name: "The broken picture" })).toHaveCount(1);
  await expect(thread.getByRole("button", { name: /The broken picture/ })).toHaveCount(0);
  await thread.getByRole("img", { name: "The broken picture" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an image with no description is named for what it is", async ({ page }) => {
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const enlarge = taskThread(page).getByRole("button", { name: "Enlarge the image", exact: true });
  await enlarge.locator("img").click();
  const dialog = page.getByRole("dialog", { name: "The image", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();
});
