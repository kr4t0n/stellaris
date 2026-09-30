import { expect, test } from "@playwright/test";
import { ANSWERED_ASK, fakeBoard } from "./board.js";

test("Space opens a composer in the sky, and an ask opens a thread in general for the front desk", async ({
  page,
}) => {
  const board = await fakeBoard(page, { asks: true });
  await page.goto("/");
  const hint = page.getByRole("button", { name: /to ask$/ });
  await expect(hint).toHaveAccessibleName("desk answered “Who reviews the survey?” Space to ask");

  await page.keyboard.press("Space");
  const box = page.getByRole("region", { name: "Ask", exact: true });
  await expect(hint).toBeHidden();
  const asks = box.getByRole("list", { name: "Your asks" });
  await expect(asks.getByRole("listitem")).toHaveCount(2);
  await expect(asks.getByRole("listitem").first()).toContainText("Who reviews the survey?");
  await expect(asks.getByRole("listitem").first()).toContainText("answered by desk");

  const field = box.getByRole("textbox", { name: "Ask the front desk" });
  await expect(field).toBeFocused();
  await field.fill("Should lab fix a seed policy?");
  await expect(box).not.toContainText("Sending wakes");
  await field.press("Enter");

  await expect(field).toHaveValue("");
  await expect(asks.getByRole("listitem")).toHaveCount(3);
  await expect(asks.getByRole("listitem").first()).toContainText("Should lab fix a seed policy?");
  await expect(asks.getByRole("listitem").first()).toContainText("desk is answering…");
  const [opened, posted] = board.writes;
  expect(opened).toEqual({
    path: "/api/verbs/open_thread",
    body: { channel: "general", title: "Should lab fix a seed policy?" },
  });
  expect(posted?.path).toBe("/api/verbs/post_message");
  expect(posted?.body).toMatchObject({ body: "Should lab fix a seed policy?" });

  // An ask opens its thread in the board, which reading clears the answer's mark.
  await asks.getByRole("link", { name: /Who reviews the survey/ }).click();
  await expect(page).toHaveURL(new RegExp(`/thread/${ANSWERED_ASK}$`));
  await expect(box).toBeHidden();
  await expect(page.getByRole("region", { name: "Board content" })).toContainText(
    "ada reviews it.",
  );
  await expect(hint).toHaveAccessibleName("Space to ask");
});

test("the ask box closes on Escape or a click away, and Space leaves a focused control alone", async ({
  page,
}) => {
  await fakeBoard(page, { asks: true });
  await page.goto("/");
  const box = page.getByRole("region", { name: "Ask", exact: true });

  await page.getByRole("button", { name: /to ask$/ }).click();
  await expect(box.getByRole("textbox", { name: "Ask the front desk" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();

  // A clicked button keeps focus but is not a keyboard user's control, so Space still asks.
  await page.getByRole("button", { name: "Board" }).click();
  await page.keyboard.press("Space");
  await expect(box).toBeVisible();
  await page.mouse.click(40, 700);
  await expect(box).toBeHidden();
  await expect(page.getByRole("region", { name: "Board content" })).toBeVisible();

  // Reached by Tab, a control takes Space as its own press.
  await page.getByRole("button", { name: /need you/ }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Pause" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(box).toBeHidden();
  await expect(page.getByRole("button", { name: /Paused/ })).toBeVisible();
});
