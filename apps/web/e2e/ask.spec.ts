import { expect, test } from "@playwright/test";
import { CLOSED_ASK, fakeBoard } from "./board.js";

test("an ask opens a thread in general and the box follows the front desk answering it", async ({
  page,
}) => {
  const board = await fakeBoard(page, { asks: true });
  await page.goto("/");
  const button = page.getByRole("button", { name: /^Ask/ });
  await expect(button).toHaveAccessibleName("Ask new answer");

  await page.keyboard.press("/");
  const island = page.getByRole("region", { name: "Ask", exact: true });
  const asks = island.getByRole("list", { name: "Your asks" });
  await expect(asks.getByRole("listitem")).toHaveCount(2);
  await expect(asks.getByRole("listitem").first()).toContainText("Who reviews the survey?");
  await expect(asks.getByRole("listitem").first()).toContainText("answered by desk");

  const box = island.getByRole("textbox", { name: "Ask the front desk" });
  await expect(box).toBeFocused();
  await box.fill("Should lab fix a seed policy?");
  await expect(island).toContainText("Sending wakes desk: a turn each.");
  await box.press("Enter");

  await expect(
    island.getByRole("heading", { name: "Should lab fix a seed policy?" }),
  ).toBeVisible();
  await expect(island).toContainText("desk is answering…");
  const [opened, posted] = board.writes;
  expect(opened).toEqual({
    path: "/api/verbs/open_thread",
    body: { channel: "general", title: "Should lab fix a seed policy?" },
  });
  expect(posted?.path).toBe("/api/verbs/post_message");
  expect(posted?.body).toMatchObject({ body: "Should lab fix a seed policy?" });

  // Reading the answer clears its mark, in the list and on the button.
  await island.getByRole("button", { name: "Back to your asks" }).click();
  await expect(asks.getByRole("listitem").first()).toContainText("desk is answering…");
  await asks.getByRole("button", { name: /Who reviews the survey/ }).click();
  await expect(island).toContainText("ada reviews it.");
  await expect(button).toHaveAccessibleName("Ask");

  // Escape in an empty box closes it; so does the button.
  await island.getByRole("textbox", { name: "Reply in the thread" }).press("Escape");
  await expect(island).toBeHidden();
  await button.click();
  await expect(island).toBeVisible();
  await button.click();
  await expect(island).toBeHidden();
});

test("a closed ask shows how it ended and a follow-up opens a new ask naming it", async ({
  page,
}) => {
  const board = await fakeBoard(page, { asks: true });
  await page.goto("/");
  await page.getByRole("button", { name: /^Ask/ }).click();
  const island = page.getByRole("region", { name: "Ask", exact: true });
  await island.getByRole("button", { name: /Merge the phone projects/ }).click();
  await expect(island).toContainText("Closed by desk");
  await expect(island).toContainText("Filed the merge as a task in lab");

  const box = island.getByRole("textbox", { name: "Follow up in a new ask" });
  await box.fill("And the iphone knowledge?");
  await box.press("Enter");
  await expect(island.getByRole("heading", { name: "And the iphone knowledge?" })).toBeVisible();
  expect(board.writes.at(-1)?.body).toMatchObject({
    body: `And the iphone knowledge?\n\nFollows up on ${CLOSED_ASK}.`,
  });

  // The board takes over from the box.
  await island.getByRole("link", { name: "Open in board →" }).click();
  await expect(page).toHaveURL(/\/thread\/01M3Q2H+\d$/);
  await expect(island).toBeHidden();
  await expect(page.getByRole("region", { name: "Board content" })).toContainText(
    "And the iphone knowledge?",
  );
});
