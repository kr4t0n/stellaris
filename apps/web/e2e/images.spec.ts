import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { IMAGE_LIMIT_BYTES } from "@stellaris/shared";
import { exifOrientation } from "@stellaris/shared/image-metadata";
import { z } from "zod";
import {
  BADGE_TARGET,
  fakeBoard,
  MISSING_IMAGE,
  PHONE_SIZE,
  png,
  PNG_SIGNATURE,
  pngChunk,
  POSTED_IMAGES,
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

  // Closed and opened again within one task, as a press can come before the browser's own
  // `close` event: the image is open, not shut a moment later.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("dialog button[aria-label='Close']")?.click();
    document
      .querySelector<HTMLButtonElement>("button[aria-label='Enlarge The survey page, before']")
      ?.click();
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
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
  // And it leaves no gap under it in its paragraph, as an inline box would for the line's descent.
  expect(
    await enlarge
      .locator("img")
      .evaluate(
        (image) =>
          (image.closest("p")?.getBoundingClientRect().bottom ?? 0) -
          image.getBoundingClientRect().bottom,
      ),
  ).toBe(0);
  // Narrower than the post: a click in the space beside it, in view, opens nothing.
  await enlarge.locator("img").scrollIntoViewIfNeeded();
  const shown = await boxOf(enlarge.locator("img"));
  expect(shown.y + shown.height).toBeLessThanOrEqual(1000);
  await page.mouse.click(shown.x + shown.width + 40, shown.y + shown.height / 2);
  await page.waitForTimeout(300);
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

test("closing the enlarged image leaves the thread where it was, with the image cut off at either edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const enlarge = taskThread(page).getByRole("button", {
    name: "Enlarge The survey page on a phone",
  });
  const image = enlarge.locator("img");
  const dialog = page.getByRole("dialog", { name: "The survey page on a phone" });
  await expect(image).toBeVisible();
  // Every image in the thread loaded, so nothing moves the list but what is under test.
  await page.waitForFunction(() => Array.from(document.images).every((each) => each.complete));

  for (const edge of ["bottom", "top"] as const) {
    for (const close of ["Escape", "a click", "Close"] as const) {
      // The list scrolled so that only 200 px of the image show, at that edge of the list.
      const shown = await image.evaluate(async (element, at) => {
        let list = element.parentElement;
        while (
          list !== null &&
          !(
            list.scrollHeight > list.clientHeight &&
            /auto|scroll/.test(getComputedStyle(list).overflowY)
          )
        ) {
          list = list.parentElement;
        }
        if (list === null) {
          return null;
        }
        const box = element.getBoundingClientRect();
        const view = list.getBoundingClientRect();
        list.scrollTop +=
          at === "bottom" ? box.top - (view.bottom - 200) : box.bottom - (view.top + 200);
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const after = element.getBoundingClientRect();
        const top = Math.max(after.top, view.top);
        const bottom = Math.min(after.bottom, view.bottom);
        return {
          scrollTop: list.scrollTop,
          cut: after.top < view.top || after.bottom > view.bottom,
          x: after.left + after.width / 2,
          y: (top + bottom) / 2,
        };
      }, edge);
      expect(shown).not.toBeNull();
      if (shown === null) {
        return;
      }
      expect(shown.cut).toBe(true);
      const listTop = () =>
        image.evaluate((element) => {
          let list = element.parentElement;
          while (
            list !== null &&
            !(
              list.scrollHeight > list.clientHeight &&
              /auto|scroll/.test(getComputedStyle(list).overflowY)
            )
          ) {
            list = list.parentElement;
          }
          return list?.scrollTop ?? null;
        });

      await page.mouse.click(shown.x, shown.y);
      await expect(dialog).toBeVisible();
      if (close === "Escape") {
        await page.keyboard.press("Escape");
      } else if (close === "a click") {
        await page.mouse.click(8, 500);
      } else {
        await dialog.getByRole("button", { name: "Close" }).click();
      }
      await expect(dialog).toHaveCount(0);
      await expect(enlarge).toBeFocused();
      expect(await listTop(), `closed by ${close}, cut off at the ${edge}`).toBe(shown.scrollTop);
    }
  }
});

for (const place of [
  { view: "a task's thread", path: `/task/${STAGE_TASK}`, name: "The survey page, before" },
  // The thread's own address lands in the task's view.
  {
    view: "a task's thread by its address",
    path: `/thread/${STAGE_TASK}`,
    landing: `/task/${STAGE_TASK}`,
    name: "The survey page, before",
  },
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
      await expect(page).toHaveURL(new RegExp(`${place.landing ?? place.path}$`));
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

/** The composer of the task's thread. */
function taskComposer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Write in the task's thread" });
}

/** Files as a page makes them: given bytes, followed by zeros up to a size when given one. */
interface PageFile {
  name: string;
  type: string;
  bytes: number[];
  size?: number;
}

/** Dispatches `kind` on the box with the files in its data, as a paste or a drop delivers them. */
function deliver(box: Locator, kind: "paste" | "drop", files: PageFile[]): Promise<void> {
  return box.evaluate(
    (element, given) => {
      const data = new DataTransfer();
      for (const file of given.files) {
        const bytes = new Uint8Array(Math.max(file.bytes.length, file.size ?? 0));
        bytes.set(file.bytes);
        data.items.add(new File([bytes], file.name, { type: file.type }));
      }
      const init = { bubbles: true, cancelable: true };
      if (given.kind === "paste") {
        element.dispatchEvent(new ClipboardEvent("paste", { ...init, clipboardData: data }));
        return;
      }
      element.dispatchEvent(new DragEvent("dragover", { ...init, dataTransfer: data }));
      element.dispatchEvent(new DragEvent("drop", { ...init, dataTransfer: data }));
    },
    { kind, files },
  );
}

test("an image pasted into a composer holds its place while it uploads, then its markdown does, and it shows in the post sent", async ({
  page,
}) => {
  const board = await fakeBoard(page, { uploads: true });
  // The board answers the upload once the test has seen it under way.
  const answer = Promise.withResolvers<void>();
  const uploads: Array<{
    type: string | undefined;
    authorization: string | undefined;
    name: string | null;
    bytes: Buffer | null;
  }> = [];
  await page.route(
    (url) => url.pathname === "/api/images",
    async (route) => {
      const request = route.request();
      uploads.push({
        type: request.headers()["content-type"],
        authorization: request.headers()["authorization"],
        name: new URL(request.url()).searchParams.get("name"),
        bytes: request.postDataBuffer(),
      });
      await answer.promise;
      await route.fallback();
    },
  );
  await page.goto(`/task/${STAGE_TASK}`);

  const box = taskComposer(page);
  const send = page.getByRole("button", { name: "Send" });
  await box.fill("The board now:  and after.");
  await box.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(15, 15));
  const shot = png(320, 200);
  await deliver(box, "paste", [{ name: "board.png", type: "image/png", bytes: [...shot] }]);
  await expect(box).toHaveValue("The board now: ![Uploading board.png…]() and after.");
  await expect(send).toBeDisabled();

  answer.resolve();
  const markdown = `![board.png](image:${POSTED_IMAGES[0]})`;
  await expect(box).toHaveValue(`The board now: ${markdown} and after.`);
  await expect(send).toBeEnabled();
  // The caret stays after the image, among the same words.
  await box.pressSequentially("!");
  await expect(box).toHaveValue(`The board now: ${markdown}! and after.`);
  expect(uploads).toEqual([
    { type: "image/png", authorization: `Bearer ${TOKEN}`, name: "board.png", bytes: shot },
  ]);

  await send.click();
  await expect(box).toHaveValue("");
  expect(board.writes.filter((write) => write.path === "/api/verbs/post_message")).toEqual([
    {
      path: "/api/verbs/post_message",
      body: { thread_id: STAGE_TASK, body: `The board now: ${markdown}! and after.` },
    },
  ]);
  const image = taskThread(page).getByRole("img", { name: "board.png" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(320);
});

test("images dropped on a composer or picked upload too, and one the board refuses or one too large leaves its reason in place of its line", async ({
  page,
}) => {
  const board = await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const box = taskComposer(page);
  const alert = page.getByRole("alert");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  await box.fill("Views:\n");

  await deliver(box, "drop", [
    { name: "wide.png", type: "image/png", bytes: [...png(400, 100)] },
    { name: "shape.svg", type: "image/svg+xml", bytes: [...svg] },
  ]);
  await expect(box).toHaveValue(`Views:\n![wide.png](image:${POSTED_IMAGES[0]})\n`);
  await expect(alert).toHaveText(
    "shape.svg is not a PNG, JPEG, GIF, or WebP image by its first bytes",
  );

  // The picker offers the kinds the board keeps, and a new image clears the last one's failure.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add images" }).click();
  const picked = await chooser;
  expect(picked.isMultiple()).toBe(true);
  expect(await picked.element().getAttribute("accept")).toBe(
    "image/png,image/jpeg,image/gif,image/webp",
  );
  await picked.setFiles({ name: "tall.png", mimeType: "image/png", buffer: png(100, 400) });
  await expect(box).toHaveValue(
    `Views:\n![wide.png](image:${POSTED_IMAGES[0]})\n![tall.png](image:${POSTED_IMAGES[1]})`,
  );
  await expect(alert).toHaveCount(0);

  // Past the board's limit, a file of a kind it doesn't keep is not sent at all, and neither is
  // an image that doesn't read to its end and that the browser can't draw.
  await deliver(box, "drop", [
    { name: "huge.bmp", type: "image/bmp", bytes: [0x42, 0x4d], size: IMAGE_LIMIT_BYTES + 1 },
  ]);
  await expect(alert).toHaveText("huge.bmp is 8388609 bytes, over the 8388608 an image may be");
  await deliver(box, "drop", [
    {
      name: "blank.png",
      type: "image/png",
      bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      size: 1000,
    },
  ]);
  await expect(alert).toHaveText(
    "blank.png does not read as a PNG; save it again and send that copy",
  );
  await expect(box).toHaveValue(
    `Views:\n![wide.png](image:${POSTED_IMAGES[0]})\n![tall.png](image:${POSTED_IMAGES[1]})`,
  );
  // The two dropped together go side by side, in either order.
  expect(
    board.writes
      .filter((write) => write.path === "/api/images")
      .map((write) => write.body)
      .toSorted((a, b) => String(a["name"]).localeCompare(String(b["name"]))),
  ).toEqual([
    { name: "shape.svg", size: svg.length },
    { name: "tall.png", size: png(100, 400).length },
    { name: "wide.png", size: png(400, 100).length },
  ]);
});

/**
 * Pastes two images both named `image.png`, as a browser names every image it pastes, the first
 * answered only once the second has settled; gives the box.
 */
async function pasteTwoAlike(page: Page, second: number[]): Promise<Locator> {
  const first = png(640, 400);
  const held = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname === "/api/images",
    async (route) => {
      if (route.request().postDataBuffer()?.length === first.length) {
        held.resolve();
        await answered.promise;
      }
      await route.fallback();
    },
  );
  await page.goto(`/task/${STAGE_TASK}`);
  const box = taskComposer(page);
  await box.fill("Before: ");
  await deliver(box, "paste", [{ name: "image.png", type: "image/png", bytes: [...first] }]);
  await expect(box).toHaveValue("Before: ![Uploading image.png…]()");
  await box.pressSequentially(" After: ");
  // The first is held, so the first answer is the second's. Each is posted once it is read, a
  // moment after its paste.
  const secondAnswered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/images",
  );
  await deliver(box, "paste", [{ name: "image.png", type: "image/png", bytes: second }]);
  await held.promise;
  await secondAnswered;
  // The first is still on its way: neither Send nor Approve takes the draft with its line in it.
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  answered.resolve();
  return box;
}

test("two images pasted under one name each land where they were pasted, whichever answers first", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  const box = await pasteTwoAlike(page, [...png(20, 20)]);
  // The second, answered first, took the board's first id; the first took the next.
  await expect(box).toHaveValue(
    `Before: ![image.png](image:${POSTED_IMAGES[1]}) After: ![image.png](image:${POSTED_IMAGES[0]})`,
  );
});

test("an image the board refuses takes only its own line from another of the same name", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  const box = await pasteTwoAlike(page, [...Buffer.from("not a picture")]);
  await expect(box).toHaveValue(`Before: ![image.png](image:${POSTED_IMAGES[0]}) After: `);
  await expect(page.getByRole("alert")).toHaveText(
    "image.png is not a PNG, JPEG, GIF, or WebP image by its first bytes",
  );
});

/** The thumbnails above the task thread's composer. */
function draftRow(page: Page): Locator {
  return page.getByRole("list", { name: "Images in the draft" });
}

test("an image in the draft shows as a thumbnail above the box, from the file while it uploads and from the board once kept, until it is sent", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  const answer = Promise.withResolvers<void>();
  const read: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/images",
    async (route) => {
      await answer.promise;
      await route.fallback();
    },
  );
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/images/")) {
      read.push(pathname);
    }
  });
  await page.goto(`/task/${STAGE_TASK}`);
  const box = taskComposer(page);
  const row = draftRow(page);
  await expect(row).toHaveCount(0);
  await box.fill("The board now: ");
  await deliver(box, "paste", [
    { name: "board.png", type: "image/png", bytes: [...png(320, 200)] },
  ]);

  // While it uploads, the file's own bytes, dimmed, saying so.
  await expect(row.getByRole("listitem")).toHaveCount(1);
  await expect(row).toContainText("Uploading…");
  await expect(
    row.getByRole("button", { name: "Remove board.png, still uploading" }),
  ).toBeVisible();
  await expect(row.locator("img")).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() => row.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(320);

  // Once kept, the board's copy by its id.
  answer.resolve();
  const kept = row.getByRole("img", { name: "board.png" });
  await expect(kept).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(row).not.toContainText("Uploading…");
  expect(read).toContain(`/api/images/${POSTED_IMAGES[0]}`);
  await expect.poll(() => kept.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320);

  await page.getByRole("button", { name: "Send" }).click();
  await expect(box).toHaveValue("");
  await expect(row).toHaveCount(0);
});

test("a thumbnail's × takes its image out of the draft, and an image typed away takes its thumbnail", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);
  const box = taskComposer(page);
  const row = draftRow(page);
  await box.fill("Before  after");
  await box.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(7, 7));
  await deliver(box, "paste", [{ name: "a.png", type: "image/png", bytes: [...png(40, 40)] }]);
  await expect(box).toHaveValue(`Before ![a.png](image:${POSTED_IMAGES[0]}) after`);
  await expect(row.getByRole("img", { name: "a.png" })).toBeVisible();

  await row.getByRole("button", { name: "Remove a.png" }).click();
  await expect(box).toHaveValue("Before  after");
  await expect(row).toHaveCount(0);
  // The × went with its thumbnail, so the keyboard is back in the box, where the image stood,
  // rather than on the page, whose shortcuts would take the keys and Escape would close the view.
  await expect(box).toBeFocused();
  await page.keyboard.type("more");
  await page.keyboard.press("Escape");
  await expect(box).toHaveValue("Before more after");
  await expect(page).toHaveURL(new RegExp(`/task/${STAGE_TASK}$`));

  // The same from the keyboard alone.
  await deliver(box, "paste", [{ name: "b.png", type: "image/png", bytes: [...png(40, 40)] }]);
  await expect(row.getByRole("img", { name: "b.png" })).toBeVisible();
  await row.getByRole("button", { name: "Remove b.png" }).focus();
  await page.keyboard.press("Enter");
  await expect(box).toBeFocused();
  await page.keyboard.type("!");
  await expect(box).toHaveValue("Before more! after");

  await deliver(box, "paste", [{ name: "c.png", type: "image/png", bytes: [...png(40, 40)] }]);
  await expect(row.getByRole("img", { name: "c.png" })).toBeVisible();
  await box.fill("Words alone");
  await expect(row).toHaveCount(0);
});

/** The images both strippers run, with what is kept of each: each kind with a made-up camera. */
const IMAGE_CASES = z
  .object({ name: z.string(), image: z.base64(), kept: z.base64().nullable() })
  .array()
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../ios/fixtures/cases/image-metadata.json", import.meta.url),
        "utf8",
      ),
    ),
  )
  .map((each) => ({
    name: each.name,
    image: Buffer.from(each.image, "base64"),
    kept: each.kept === null ? null : Buffer.from(each.kept, "base64"),
  }));

/** The case of that name, and what is kept of it. */
function imageCase(name: string): { image: Buffer; kept: Buffer } {
  const found = IMAGE_CASES.find((each) => each.name === name);
  if (found?.kept == null) {
    throw new Error(`no image case named ${name} that is kept`);
  }
  return { image: found.image, kept: found.kept };
}

/** A camera's photo: a JPEG with its make, a place, and an orientation that turns it. */
const CAMERA_PHOTO = imageCase("a camera's JPEG");

/** The camera's Exif segment, marker and length included, as a JPEG holds it. */
function cameraExifSegment(): Buffer {
  const exif = CAMERA_PHOTO.image.indexOf("Exif\0\0", 0, "latin1");
  return CAMERA_PHOTO.image.subarray(
    exif - 4,
    exif - 2 + CAMERA_PHOTO.image.readUInt16BE(exif - 2),
  );
}

/** The orientation a JPEG's Exif gives, 1 when it has none. */
function jpegOrientation(bytes: Buffer): number {
  const exif = bytes.indexOf("Exif\0\0", 0, "latin1");
  return exif === -1 ? 1 : exifOrientation(bytes.subarray(exif));
}

/** A JPEG's width and height, from its frame's header. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let at = 2;
  while (at + 9 < bytes.length) {
    const marker = bytes[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  throw new Error("no frame header");
}

/** What the composer posted to `/api/images`, each answered with the next id the board gives. */
async function recordUploads(
  page: Page,
): Promise<Map<string, { type: string | undefined; bytes: Buffer }>> {
  const posted = new Map<string, { type: string | undefined; bytes: Buffer }>();
  await page.route(
    (url) => url.pathname === "/api/images",
    async (route: Route) => {
      const request = route.request();
      const name = new URL(request.url()).searchParams.get("name") ?? "";
      const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
      const id = POSTED_IMAGES[posted.size] ?? "";
      posted.set(name, { type: request.headers()["content-type"], bytes });
      await route.fulfill({
        json: { id, type: "jpeg", size: bytes.length, markdown: `![${name}](image:${id})` },
      });
    },
  );
  return posted;
}

test("an image posted from a composer goes without its metadata, as the board keeps it: a camera's photo without its camera and its place, turned as it was", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  const posted = await recordUploads(page);
  await page.goto(`/task/${STAGE_TASK}`);
  const box = taskComposer(page);
  const kinds = [
    ["photo.jpg", "image/jpeg", CAMERA_PHOTO],
    ["moving.png", "image/png", imageCase("a camera's APNG")],
    ["moving.gif", "image/gif", imageCase("an animated GIF")],
  ] as const;
  await deliver(
    box,
    "paste",
    kinds.map(([name, type, { image }]) => ({ name, type, bytes: [...image] })),
  );
  await expect(box).toHaveValue(/^(?:!\[[a-z.]+\]\(image:\w+\)\n?){3}$/);

  for (const [name, type, { kept }] of kinds) {
    expect(posted.get(name), name).toEqual({ type, bytes: kept });
  }
  const photo = posted.get("photo.jpg")?.bytes ?? Buffer.alloc(0);
  // The made-up camera's make, and its GPS directory's latitude reference, a southern one.
  const south = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x53]);
  expect(CAMERA_PHOTO.image.includes("Example\0")).toBe(true);
  expect(CAMERA_PHOTO.image.includes(south)).toBe(true);
  expect(photo.includes("Example")).toBe(false);
  expect(photo.includes(south)).toBe(false);
  expect(jpegOrientation(CAMERA_PHOTO.image)).toBe(6);
  expect(jpegOrientation(photo)).toBe(6);
});

test("a page left open across a deploy still posts an image without its metadata, with no chunk it hadn't loaded", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  const posted = await recordUploads(page);
  await page.goto(`/task/${STAGE_TASK}`);
  const box = taskComposer(page);
  await expect(box).toBeVisible();
  // A deploy renames every chunk, so the server answers one the page asks for only now with a 404.
  await page.route("**/assets/**", (route) => route.fulfill({ status: 404, body: "" }));
  await deliver(box, "paste", [
    { name: "photo.jpg", type: "image/jpeg", bytes: [...CAMERA_PHOTO.image] },
  ]);
  await expect(box).toHaveValue(`![photo.jpg](image:${POSTED_IMAGES[0]})`);
  expect(posted.get("photo.jpg")).toEqual({ type: "image/jpeg", bytes: CAMERA_PHOTO.kept });
});

test("a photo over the limit only for what follows its picture goes without it, neither refused nor drawn again", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  const posted = await recordUploads(page);
  await page.goto(`/task/${STAGE_TASK}`);
  const box = taskComposer(page);
  // As an HDR gain map or a motion photo's video follows a camera's picture.
  await deliver(box, "drop", [
    {
      name: "motion.jpg",
      type: "image/jpeg",
      bytes: [...CAMERA_PHOTO.image],
      size: CAMERA_PHOTO.image.length + IMAGE_LIMIT_BYTES,
    },
  ]);
  await expect(box).toHaveValue(`![motion.jpg](image:${POSTED_IMAGES[0]})`);
  expect(posted.get("motion.jpg")).toEqual({ type: "image/jpeg", bytes: CAMERA_PHOTO.kept });
});

test("a photo cut short goes as a JPEG of its picture drawn again upright, with none of its metadata", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  const posted = await recordUploads(page);
  await page.goto(`/task/${STAGE_TASK}`);
  // A 400 by 300 picture, blue at its top left and red elsewhere, as the browser encodes it.
  const picture = Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const context = canvas.getContext("2d");
      if (context === null) {
        return [];
      }
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, 400, 300);
      context.fillStyle = "#0000ff";
      context.fillRect(0, 0, 100, 100);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.95);
      });
      return [...new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))];
    }),
  );
  // The camera's Exif after the start of the image, then all of it but its last 100 bytes.
  const photo = Buffer.concat([picture.subarray(0, 2), cameraExifSegment(), picture.subarray(2)]);
  const cut = photo.subarray(0, -100);
  expect(jpegOrientation(cut)).toBe(6);
  expect(cut.includes("Example\0")).toBe(true);
  const box = taskComposer(page);
  await deliver(box, "paste", [{ name: "cut.jpg", type: "image/jpeg", bytes: [...cut] }]);
  await expect(box).toHaveValue(`![cut.jpg](image:${POSTED_IMAGES[0]})`);

  const sent = posted.get("cut.jpg");
  expect(sent?.type).toBe("image/jpeg");
  const bytes = sent?.bytes ?? Buffer.alloc(0);
  expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  expect(bytes.includes("Exif")).toBe(false);
  expect(bytes.includes("Example")).toBe(false);
  // Turned upright: 300 wide and 400 tall, with the blue that was at the top left at the top right.
  expect(jpegSize(bytes)).toEqual({ width: 300, height: 400 });
  const corners = await page.evaluate(
    async (given) => {
      const image = await createImageBitmap(new Blob([new Uint8Array(given)]));
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context?.drawImage(image, 0, 0);
      const blue = (x: number, y: number): boolean => {
        const [red = 0, , bluePart = 0] = context?.getImageData(x, y, 1, 1).data ?? [];
        return bluePart > 128 && red < 128;
      };
      return { topLeft: blue(10, 10), topRight: blue(image.width - 10, 10) };
    },
    [...bytes],
  );
  expect(corners).toEqual({ topLeft: false, topRight: true });
});

/**
 * A PNG of a gradient `width` by `height` pixels with alpha, at `depth` bits a channel, its image
 * data stored without compression when `stored`, so that its size is its pixels'.
 */
function gradientPng(width: number, height: number, depth: 8 | 16, stored: boolean): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([depth, 6, 0, 0, 0], 8);
  const channel = depth / 8;
  const row = 1 + width * 4 * channel;
  const rows = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 4 * channel;
      const pixel = [(x * 255) / width, (y * 255) / height, 128, 255];
      pixel.forEach((value, index) => {
        rows.fill(Math.round(value), at + index * channel, at + (index + 1) * channel);
      });
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: stored ? 0 : 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Pastes `bytes` into the box as a PNG named `name`, which the page reads from a route rather
 * than from the test's arguments, too large to pass.
 */
async function pasteServed(page: Page, box: Locator, name: string, bytes: Buffer): Promise<void> {
  await page.route(`**/e2e-files/${name}`, (route) =>
    route.fulfill({ contentType: "application/octet-stream", body: bytes }),
  );
  await box.evaluate(async (element, fileName) => {
    const blob = await (await fetch(`/e2e-files/${fileName}`)).blob();
    const data = new DataTransfer();
    data.items.add(new File([blob], fileName, { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  }, name);
}

test("an image still past the limit without its metadata, or one cut short, goes as a JPEG drawn again, at most 4,096 pixels on its longest side", async ({
  page,
}) => {
  await fakeBoard(page, { uploads: true });
  const posted = await recordUploads(page);
  await page.goto(`/task/${STAGE_TASK}`);
  const box = taskComposer(page);

  // Its pictures alone are past the limit, at 16 bits a channel stored as they are.
  const deep = gradientPng(1100, 1000, 16, true);
  expect(deep.length).toBeGreaterThan(IMAGE_LIMIT_BYTES);
  await pasteServed(page, box, "deep.png", deep);
  await expect(box).toHaveValue(`![deep.png](image:${POSTED_IMAGES[0]})`, { timeout: 15_000 });
  const first = posted.get("deep.png")?.bytes ?? Buffer.alloc(0);
  expect(posted.get("deep.png")?.type).toBe("image/jpeg");
  expect(jpegSize(first)).toEqual({ width: 1100, height: 1000 });

  // Wider than 4,096 pixels, and cut short before its end.
  await box.fill("");
  const wide = gradientPng(4400, 40, 8, false);
  await pasteServed(page, box, "wide.png", wide.subarray(0, -12));
  await expect(box).toHaveValue(`![wide.png](image:${POSTED_IMAGES[1]})`, { timeout: 15_000 });
  const second = posted.get("wide.png")?.bytes ?? Buffer.alloc(0);
  expect(posted.get("wide.png")?.type).toBe("image/jpeg");
  expect(jpegSize(second)).toEqual({ width: 4096, height: 37 });
});
