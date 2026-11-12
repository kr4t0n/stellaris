import { expect, test, type Locator } from "@playwright/test";
import { ANSWERED_ASK, fakeBoard } from "./board.js";

/** How Send is drawn: its size, how round it is, its glyph's colour, and where it sits. */
function shapeOf(send: Locator) {
  return send.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      radius: Number.parseFloat(style.borderTopLeftRadius),
      color: style.color,
      left: box.left,
    };
  });
}

for (const place of [
  { name: "a channel", path: "/c/lab/general", box: "Message #general" },
  { name: "a thread", path: `/thread/${ANSWERED_ASK}`, box: "Reply in the thread" },
]) {
  test(`${place.name}'s Send is a round arrow beside its box, dim until there is something to send, and turns while it posts with the box's width unchanged`, async ({
    page,
  }) => {
    const board = await fakeBoard(page, { asks: true });
    await page.goto(place.path);
    const view = page.getByRole("region", { name: "Board content" });
    const box = view.getByRole("textbox", { name: place.box });
    const send = view.getByRole("button", { name: "Send" });

    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute("title", "Send");
    const dim = await shapeOf(send);
    expect(dim.width).toBe(40);
    expect(dim.height).toBe(40);
    expect(dim.radius).toBeGreaterThanOrEqual(20);
    const field = await box.boundingBox();
    if (field === null) {
      throw new Error("the box is not laid out");
    }
    expect(dim.left).toBeGreaterThan(field.x + field.width);

    await box.fill("The nightly is green again.");
    await expect(send).toBeEnabled();
    // Lit, once its colour has eased over.
    await expect.poll(async () => (await shapeOf(send)).color).not.toBe(dim.color);

    // The post is held on its way: Send turns, keeps its name, and the box keeps its width.
    const width = await box.evaluate((element) => element.getBoundingClientRect().width);
    const held = Promise.withResolvers<void>();
    await page.route("**/api/verbs/post_message", async (route) => {
      await held.promise;
      await route.fallback();
    });
    await send.click();
    await expect(send).toHaveAttribute("aria-busy", "true");
    await expect(send).toHaveAccessibleName("Send");
    await expect(send.locator('svg[class*="animate-spin"]')).toHaveCount(1);
    expect(await box.evaluate((element) => element.getBoundingClientRect().width)).toBe(width);
    held.resolve();
    await expect(send).toHaveAttribute("aria-busy", "false");
    await expect(box).toHaveValue("");
    expect(board.writes.at(-1)?.path).toBe("/api/verbs/post_message");
  });
}

test("the ask box's Send is the same round arrow beside it", async ({ page }) => {
  await fakeBoard(page, { asks: true });
  await page.goto("/");
  // Space opens the ask box once the board listens for it, as its hint shows.
  await expect(page.getByRole("button", { name: /to ask$/ })).toBeVisible();
  await page.keyboard.press("Space");
  const ask = page.getByRole("region", { name: "Ask", exact: true });
  const send = ask.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  const shape = await shapeOf(send);
  expect(shape.width).toBe(40);
  expect(shape.radius).toBeGreaterThanOrEqual(20);
  const field = await ask.getByRole("textbox", { name: "Ask the front desk" }).boundingBox();
  if (field === null) {
    throw new Error("the box is not laid out");
  }
  expect(shape.left).toBeGreaterThan(field.x + field.width);
});
