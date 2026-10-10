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

test("the user approves a stage that names them, and a ghpr task shows the pull request it lands through", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = page.getByRole("region", { name: "Board content" });
  const pull = view.getByRole("region", { name: "Pull request" });
  await expect(pull.getByRole("link", { name: "#7 on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/acme/lab/pull/7",
  );
  // What lands on the default branch is the merge commit the agent wrote, not the pull request's text.
  await expect(pull).toContainText("feat: compare shortest-path algorithms");
  await expect(pull).toContainText("Co-Authored-By: ada <ada@x>");

  const approval = view.getByRole("form", { name: "Approve Sign off" });
  await expect(approval).toContainText(
    "Approving lands it: the board merges pull request #7 on GitHub.",
  );
  await approval.getByRole("textbox", { name: "Note for the task's thread" }).fill("LGTM");
  await approval.getByRole("button", { name: "Approve" }).click();
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/advance_task",
    body: { task_id: STAGE_TASK, note: "LGTM" },
  });
  // Landing, the task no longer waits on the user.
  await expect(approval).toHaveCount(0);
  await expect(view).toContainText("landing");
});
