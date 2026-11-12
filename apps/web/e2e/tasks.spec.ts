import { expect, test, type Locator, type Page } from "@playwright/test";
import { fakeBoard, STAGE_TASK } from "./board.js";

function viewOf(page: Page): Locator {
  return page.getByRole("region", { name: "Board content" });
}

/** The task's top, which stays above its thread. */
function topOf(page: Page): Locator {
  return viewOf(page).getByRole("region", { name: "Where the task stands" });
}

test("a task's view holds its thread: each handover with its step, and what the user writes", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = viewOf(page);
  const thread = view.getByRole("region", { name: "Thread" });
  await expect(thread).toContainText("finished Survey → Sign off");
  await expect(thread).toContainText("Survey done: twelve methods in SURVEY.md, with sources.");

  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  await box.fill("Reading it now; I'll sign off today.");
  // One row: the round Send sits beside the box, at its end, with no line under it.
  const send = view.getByRole("button", { name: "Send" });
  const field = await box.boundingBox();
  const button = await send.boundingBox();
  if (field === null || button === null) {
    throw new Error("the composer is not laid out");
  }
  expect(button.x).toBeGreaterThan(field.x + field.width);
  expect(button.y + button.height).toBeLessThanOrEqual(field.y + field.height + 8);
  await expect(view).not.toContainText("Sending wakes");
  await box.press("Enter");
  await expect(thread).toContainText("Reading it now; I'll sign off today.");
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/post_message",
    body: { thread_id: STAGE_TASK, body: "Reading it now; I'll sign off today." },
  });
});

test("the top holds the plan's strip and the stage, and its rows open the plan, the files, the brief and the pull request in place", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = viewOf(page);
  const top = topOf(page);
  await expect(top).toContainText("Stage 2 of 2 · Sign off");
  await expect(top).toContainText("gate");
  await expect(top).toContainText("waiting on you since");
  await expect(view.locator("header").first()).toContainText("waiting on you");
  // The header no longer repeats the stage the top shows.
  await expect(view.locator("header").first()).not.toContainText("Stage 2 of 2");

  // Every row starts closed, each with a line of where its part stands.
  const plan = top.getByRole("button", { name: /^Plan/ });
  const files = top.getByRole("button", { name: /^Files/ });
  const brief = top.getByRole("button", { name: /^Brief/ });
  const pull = top.getByRole("button", { name: /^Pull request/ });
  for (const row of [plan, files, brief, pull]) {
    await expect(row).toHaveAttribute("aria-expanded", "false");
  }
  await expect(plan).toContainText("2 stages · when done, #7 merges on GitHub");
  await expect(files).toContainText("4 files · +");
  await expect(brief).toContainText("Survey the field and tabulate the methods.");
  await expect(pull).toContainText("#7 · feat: compare shortest-path algorithms · by ada");
  for (const name of ["Plan", "Files", "Brief", "Pull request"]) {
    await expect(top.getByRole("region", { name })).toHaveCount(0);
  }

  await plan.click();
  await expect(plan).toHaveAttribute("aria-expanded", "true");
  const timeline = top.getByRole("region", { name: "Plan" });
  await expect(timeline).toContainText("Survey");
  await expect(timeline).toContainText("done by ada");
  await expect(timeline).toContainText(
    "When the last stage is done: pull request #7 merges on GitHub",
  );

  await pull.click();
  const request = top.getByRole("region", { name: "Pull request" });
  await expect(request.getByRole("link", { name: "#7 on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/acme/lab/pull/7",
  );
  // What lands on the default branch is the merge commit the agent wrote, not the pull request's text.
  await expect(request).toContainText("Co-Authored-By: ada <ada@x>");

  await brief.click();
  await files.click();
  await expect(top.getByRole("region", { name: "Files" })).toContainText("report.md");

  // Open, they take at most half the room between the header and the box, and scroll past it.
  const room = await top.evaluate((element) => {
    const parent = element.parentElement;
    return parent === null
      ? null
      : {
          top: element.getBoundingClientRect().height,
          shared: parent.getBoundingClientRect().height,
          scrolls: element.scrollHeight > element.clientHeight,
        };
  });
  expect(room).not.toBeNull();
  expect(room?.top).toBeLessThanOrEqual((room?.shared ?? 0) / 2 + 1);
  expect(room?.scrolls).toBe(true);

  await plan.click();
  await expect(plan).toHaveAttribute("aria-expanded", "false");
  await expect(top.getByRole("region", { name: "Plan" })).toHaveCount(0);
});

test("the user approves a stage that names them from the thread's box, its text the step's note", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = viewOf(page);
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  const approve = view.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeEnabled();
  await expect(approve).toHaveAttribute(
    "title",
    "Approve Sign off, with what the box holds as its note",
  );
  // The check stands to the right of Send, at the box's end, and comes after it from the keyboard.
  const check = await approve.boundingBox();
  const sendButton = view.getByRole("button", { name: "Send" });
  const send = await sendButton.boundingBox();
  if (check === null || send === null) {
    throw new Error("the composer is not laid out");
  }
  expect(send.x + send.width).toBeLessThanOrEqual(check.x);

  await box.fill("LGTM");
  await sendButton.focus();
  await page.keyboard.press("Tab");
  await expect(approve).toBeFocused();
  await approve.click();
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/advance_task",
    body: { task_id: STAGE_TASK, note: "LGTM" },
  });
  // Landing, the task no longer waits on the user: the check goes, and the keyboard stays in the box.
  await expect(approve).toHaveCount(0);
  await expect(view.locator("header").first()).toContainText("landing");
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
});

for (const press of ["mouse", "keyboard"] as const) {
  test(`a refused Approve, pressed by ${press}, keeps the note in the box with the keyboard there, so Escape leaves the board open`, async ({
    page,
  }) => {
    await fakeBoard(page);
    await page.route("**/api/verbs/advance_task", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "INVALID_STATE",
          message: "The stage Sign off is no longer current.",
        }),
      });
    });
    await page.goto(`/task/${STAGE_TASK}`);

    const view = viewOf(page);
    const box = view.getByRole("textbox", { name: "Write in the task's thread" });
    const approve = view.getByRole("button", { name: "Approve", exact: true });
    await box.fill("LGTM");
    if (press === "mouse") {
      await approve.click();
    } else {
      await view.getByRole("button", { name: "Send" }).focus();
      await page.keyboard.press("Tab");
      await expect(approve).toBeFocused();
      await page.keyboard.press("Enter");
    }
    // While it goes, and once it is refused, the keyboard is in the box, never on the page.
    await expect(approve).toHaveAttribute("aria-busy", "true");
    await expect(box).toBeFocused();
    await expect(view.getByRole("alert")).toHaveText("The stage Sign off is no longer current.");
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("LGTM");
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(`/task/${STAGE_TASK}`);
    await expect(box).toHaveValue("LGTM");

    // A post afterwards says no more of the refusal.
    await box.press("Enter");
    await expect(view.getByRole("region", { name: "Thread" })).toContainText("LGTM");
    await expect(view.getByRole("alert")).toHaveCount(0);
  });
}

test("Space while an approval goes types in the box rather than opening the ask box", async ({
  page,
}) => {
  await fakeBoard(page);
  const held = Promise.withResolvers<void>();
  await page.route("**/api/verbs/advance_task", async (route) => {
    await held.promise;
    await route.fallback();
  });
  await page.goto(`/task/${STAGE_TASK}`);

  const view = viewOf(page);
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  const approve = view.getByRole("button", { name: "Approve", exact: true });
  await approve.click();
  await expect(approve).toHaveAttribute("aria-busy", "true");
  await page.keyboard.press("Space");
  await expect(page.getByRole("region", { name: "Ask", exact: true })).toHaveCount(0);
  held.resolve();
  await expect(approve).toHaveCount(0);
  await expect(box).toBeFocused();
});

test("Enter in the box posts and never approves, and Approve with the box empty sends no note", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = viewOf(page);
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  await box.fill("One question first.");
  await box.press("Enter");
  await expect(view.getByRole("region", { name: "Thread" })).toContainText("One question first.");
  expect(board.writes.map((write) => write.path)).toEqual(["/api/verbs/post_message"]);

  await expect(box).toHaveValue("");
  await view.getByRole("button", { name: "Approve", exact: true }).click();
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/advance_task",
    body: { task_id: STAGE_TASK },
  });
});

test("on a ghpr task's last stage with no pull request linked, Approve waits greyed with its reason in its tooltip and nothing under the box", async ({
  page,
}) => {
  const board = await fakeBoard(page, { unlinked: true });
  await page.goto(`/task/${STAGE_TASK}`);

  const view = viewOf(page);
  const approve = view.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute("title", "No pull request linked yet.");
  await expect(view).not.toContainText("No pull request linked yet");
  // The top's row says so instead.
  await expect(topOf(page).getByRole("button", { name: /^Pull request/ })).toContainText(
    "None linked yet",
  );
  // Send still posts.
  await view.getByRole("textbox", { name: "Write in the task's thread" }).fill("Link it, please.");
  await view.getByRole("button", { name: "Send" }).click();
  expect(board.writes.at(-1)?.path).toBe("/api/verbs/post_message");
});

test("Approve before a ghpr task's last stage says nothing of its pull request", async ({
  page,
}) => {
  await fakeBoard(page, { earlyApproval: true });
  await page.goto(`/task/${STAGE_TASK}`);

  const approve = viewOf(page).getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeEnabled();
  await expect(approve).toHaveAttribute(
    "title",
    "Approve Check, with what the box holds as its note",
  );
});

test("a stage that names the user but isn't a gate is finished with Advance", async ({ page }) => {
  const board = await fakeBoard(page, { ungated: true });
  await page.goto(`/task/${STAGE_TASK}`);

  const view = viewOf(page);
  await expect(view.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  const advance = view.getByRole("button", { name: "Advance", exact: true });
  await expect(advance).toHaveAttribute(
    "title",
    "Advance Check, with what the box holds as its note",
  );
  await advance.click();
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/advance_task",
    body: { task_id: STAGE_TASK },
  });
});

test("a task with no thread to write in still gets Approve, alone", async ({ page }) => {
  const board = await fakeBoard(page);
  await page.route("**/api/threads", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await page.goto(`/task/${STAGE_TASK}`);

  const view = viewOf(page);
  await expect(view).toContainText("No thread on this task.");
  await expect(view.getByRole("textbox", { name: "Write in the task's thread" })).toHaveCount(0);
  await view.getByRole("button", { name: "Approve", exact: true }).click();
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/advance_task",
    body: { task_id: STAGE_TASK },
  });
});
