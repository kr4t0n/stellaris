import { expect, test } from "@playwright/test";
import { fakeBoard, STAGE_TASK } from "./board.js";

test("a task's view holds its thread: each handover with its step, and what the user writes", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = page.getByRole("region", { name: "Board content" });
  await expect(view).toContainText("Survey the field and tabulate the methods.");
  const thread = view.getByRole("region", { name: "Thread" });
  await expect(thread).toContainText("finished Survey → Sign off");
  await expect(thread).toContainText("Survey done: twelve methods in SURVEY.md, with sources.");

  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  await box.fill("Reading it now; I'll sign off today.");
  await box.press("Enter");
  await expect(thread).toContainText("Reading it now; I'll sign off today.");
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/post_message",
    body: { thread_id: STAGE_TASK, body: "Reading it now; I'll sign off today." },
  });
});
