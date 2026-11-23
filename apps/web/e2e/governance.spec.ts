import { expect, test } from "@playwright/test";
import { ARCHIVE_PROPOSAL, fakeBoard, SKILL_PROPOSAL, STAGE_TASK } from "./board.js";

test("a message named by its id reads as who posted it where, and opens there, marked", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);
  const thread = page.getByRole("region", { name: "Thread" });
  const link = thread.getByRole("link", { name: "ada's post in Compare shortest-path algorithms" });
  await expect(link).toBeVisible();
  // "message" before the id, and whose it was, are the title's to say.
  await expect(thread).toContainText("It follows ada's post in Compare shortest-path algorithms.");
  await link.click();
  // A message in a task's thread opens in the task's view, which holds the thread.
  await expect(page).toHaveURL(new RegExp(`/task/${STAGE_TASK}\\?message=`));
  const marked = page.locator('article[aria-current="true"]');
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText("Survey done: twelve methods");
});

test("a proposal's thread shows without waiting for the list of every thread", async ({ page }) => {
  await fakeBoard(page);
  const { promise: listed, resolve: list } = Promise.withResolvers<void>();
  let asked = false;
  // Registered after the fake board, so it answers first and holds the list back.
  await page.route("**/api/threads", async (route) => {
    asked = true;
    await listed;
    await route.fallback();
  });
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  await expect(page.getByRole("region", { name: "Thread" })).toContainText("refereed-research");
  // The navigator asked for the list, which is still on its way.
  await expect.poll(() => asked).toBe(true);
  list();
});

test("a skill proposed as a folder shows its SKILL.md and opens each file beside it", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  await expect(page.getByText("stew's home at 4f1c2d9")).toBeVisible();
  await expect(page.getByText("Run scripts/plan.sh first.")).toBeVisible();
  const script = page.getByRole("button", { name: /scripts\/plan\.sh/ });
  await expect(script).toContainText("executable");
  await expect(script).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("echo stages: work review")).toHaveCount(0);
  await script.click();
  await expect(script).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("echo stages: work review")).toBeVisible();
});

test("the user approves from the thread's box with the check, its text the reason, and sees what it made", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  await expect(page.getByText("If approved: Publishes refereed-research")).toBeVisible();
  await expect(page.getByRole("region", { name: "Governance" })).toContainText("proposals1");
  // The pitch opened the proposal's thread, shown in its view.
  const thread = page.getByRole("region", { name: "Thread" });
  await expect(thread).toContainText("The plan has run on four tasks.");
  // No bar under the box: the header says whom it waits on.
  await expect(page.getByText("This proposal waits on you.")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Board content" }).locator("header").first(),
  ).toContainText("for you or another steward to decide");

  const box = page.getByRole("textbox", { name: "Write in the thread" });
  const send = page.getByRole("button", { name: "Send" });
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toHaveAttribute(
    "title",
    "Approve the proposal, with what the box holds as the reason",
  );
  // One row: the box, Send, Approve, then Reject at its end, in that order from the keyboard too.
  const [boxAt, sendAt, approveAt, rejectAt] = await Promise.all(
    [box, send, approve, reject].map((each) => each.boundingBox()),
  );
  if (boxAt == null || sendAt == null || approveAt == null || rejectAt == null) {
    throw new Error("the composer is not laid out");
  }
  expect(boxAt.x + boxAt.width).toBeLessThanOrEqual(sendAt.x);
  expect(sendAt.x + sendAt.width).toBeLessThanOrEqual(approveAt.x);
  expect(approveAt.x + approveAt.width).toBeLessThanOrEqual(rejectAt.x);
  for (const each of [sendAt, approveAt]) {
    expect(each.y + each.height).toBe(rejectAt.y + rejectAt.height);
  }

  await box.fill("Four tasks are enough.");
  await send.focus();
  await page.keyboard.press("Tab");
  await expect(approve).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(reject).toBeFocused();
  // One press decides.
  await approve.click();
  await expect(page.getByText("Approved by you")).toContainText(": Four tasks are enough.");
  await expect(thread).toContainText("Approved: skill refereed-research.");
  await expect(page.getByText("Published the society's skill refereed-research.")).toBeVisible();
  expect(board.writes).toEqual([
    {
      path: "/api/verbs/approve",
      body: { proposal_id: SKILL_PROPOSAL, reason: "Four tasks are enough." },
    },
  ]);
  // Decided, it waits on nobody: the buttons go with the thread's box, which closed.
  await expect(approve).toHaveCount(0);
  await expect(reject).toHaveCount(0);
  await expect(box).toHaveCount(0);
});

test("Enter in the proposal's box posts and never decides, and the check with the box empty sends no reason", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  const box = page.getByRole("textbox", { name: "Write in the thread" });
  await box.fill("Which four tasks?");
  await box.press("Enter");
  await expect(page.getByRole("region", { name: "Thread" })).toContainText("Which four tasks?");
  expect(board.writes.map((write) => write.path)).toEqual(["/api/verbs/post_message"]);

  await expect(box).toHaveValue("");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved by you")).toBeVisible();
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/approve",
    body: { proposal_id: SKILL_PROPOSAL },
  });
});

test("signed in with GitHub, the user's posts and names show the account", async ({ page }) => {
  await fakeBoard(page, { github: true });
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved by octocat")).toBeVisible();

  const decision = page
    .getByRole("region", { name: "Thread" })
    .getByRole("article")
    .filter({ hasText: "Approved: skill refereed-research." });
  await expect(decision.getByText("octocat", { exact: true })).toBeVisible();
  // The account's picture, at the size the post shows it, in place of the "you" mark.
  const avatar = decision.locator("img");
  await expect(avatar).toHaveAttribute(
    "src",
    "https://avatars.githubusercontent.com/u/583231?v=4&s=56",
  );
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await expect(decision.getByText("you", { exact: true })).toHaveCount(0);
});

test("a rejection needs a reason: the cross waits greyed while the box is empty, then takes its text", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  const box = page.getByRole("textbox", { name: "Write in the thread" });
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  await expect(reject).toHaveAttribute("aria-disabled", "true");
  await expect(reject).toHaveAttribute("title", "Write why in the box to reject");
  // Pressed, it does nothing.
  await reject.click({ force: true });
  await expect(page.getByText("If approved:")).toBeVisible();
  expect(board.writes).toEqual([]);
  // Spaces are no reason.
  await box.fill("   ");
  await expect(reject).toHaveAttribute("aria-disabled", "true");

  await box.fill("Not before the next study.");
  await expect(reject).toHaveAttribute("aria-disabled", "false");
  await expect(reject).toHaveAttribute(
    "title",
    "Reject the proposal, with what the box holds as the reason",
  );
  await reject.click();
  await expect(page.getByText(/^Rejected by you .*: Not before the next study\.$/)).toBeVisible();
  expect(board.writes).toEqual([
    {
      path: "/api/verbs/reject",
      body: { proposal_id: SKILL_PROPOSAL, reason: "Not before the next study." },
    },
  ]);
});

test("while a decision goes, its button turns and nothing else in the row goes", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  const held = Promise.withResolvers<void>();
  await page.route("**/api/verbs/approve", async (route) => {
    await held.promise;
    await route.fallback();
  });
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  const box = page.getByRole("textbox", { name: "Write in the thread" });
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  await box.fill("Four tasks are enough.");
  await approve.click();
  await expect(approve).toHaveAttribute("aria-busy", "true");
  await expect(reject).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  // The keyboard is back in the box, where Enter sends nothing while the decision goes.
  await expect(box).toBeFocused();
  await reject.click({ force: true });
  await box.press("Enter");
  held.resolve();
  await expect(page.getByText("Approved by you")).toBeVisible();
  expect(board.writes.map((write) => write.path)).toEqual(["/api/verbs/approve"]);
});

test("a proposal with no thread to write in gets a box for the reason alone, with both buttons", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.route(`**/api/threads/${SKILL_PROPOSAL}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "NOT_FOUND", message: `no thread ${SKILL_PROPOSAL}` }),
    }),
  );
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  await expect(page.getByText("No thread on this proposal.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  const reason = page.getByRole("textbox", { name: "Reason" });
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  const [approveAt, rejectAt] = await Promise.all(
    [approve, reject].map((each) => each.boundingBox()),
  );
  if (approveAt == null || rejectAt == null) {
    throw new Error("the buttons are not laid out");
  }
  expect(approveAt.x + approveAt.width).toBeLessThanOrEqual(rejectAt.x);
  await expect(reject).toHaveAttribute("aria-disabled", "true");
  await expect(reject).toHaveAttribute("title", "Write why in the box to reject");
  await reason.fill("Not before the next study.");
  const held = Promise.withResolvers<void>();
  await page.route("**/api/verbs/reject", async (route) => {
    await held.promise;
    await route.fallback();
  });
  await reject.click();
  // As in the thread's box, the pressed button turns and the keyboard goes back to the box.
  await expect(reject).toHaveAttribute("aria-busy", "true");
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect(reason).toBeFocused();
  held.resolve();
  await expect(page.getByText(/^Rejected by you .*: Not before the next study\.$/)).toBeVisible();
  expect(board.writes).toEqual([
    {
      path: "/api/verbs/reject",
      body: { proposal_id: SKILL_PROPOSAL, reason: "Not before the next study." },
    },
  ]);
  await expect(reason).toHaveCount(0);
});

test("the box for the reason alone grows with its text, as the thread's box does", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.route(`**/api/threads/${SKILL_PROPOSAL}`, (route) =>
    route.fulfill({
      status: 404,
      json: { error: "NOT_FOUND", message: `no thread ${SKILL_PROPOSAL}` },
    }),
  );
  await page.setViewportSize({ width: 376, height: 800 });
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);
  const reason = page.getByRole("textbox", { name: "Reason" });
  const oneLine = await reason.evaluate((element) => element.clientHeight);
  await reason.fill("Four tasks ran it, and the referee caught two wrong figures.");
  // Taller than one line, with nothing scrolled out of sight.
  await expect
    .poll(() => reason.evaluate((element) => element.clientHeight))
    .toBeGreaterThan(oneLine);
  expect(await reason.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
});

test("a proposal whose thread can't be read can still be decided, from the box for the reason alone", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  let reads = 0;
  await page.route(`**/api/threads/${SKILL_PROPOSAL}`, (route) => {
    reads += 1;
    return route.fulfill({ status: 500, json: { error: "INTERNAL", message: "disk full" } });
  });
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  const reason = page.getByRole("textbox", { name: "Reason" });
  await expect(reason).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  expect(reads).toBeGreaterThan(0);
  await reason.fill("Four tasks are enough.");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved by you")).toBeVisible();
  expect(board.writes).toEqual([
    {
      path: "/api/verbs/approve",
      body: { proposal_id: SKILL_PROPOSAL, reason: "Four tasks are enough." },
    },
  ]);
});

test("while the proposal's thread is on its way, its foot waits, never showing the box for a reason alone", async ({
  page,
}) => {
  await fakeBoard(page);
  const held = Promise.withResolvers<void>();
  await page.route(`**/api/threads/${SKILL_PROPOSAL}`, async (route) => {
    await held.promise;
    await route.fallback();
  });
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);
  await expect(page.getByText("If approved: Publishes refereed-research")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Reason" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  held.resolve();
  await expect(page.getByRole("textbox", { name: "Write in the thread" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Reason" })).toHaveCount(0);
});

test("a reason typed for one proposal stays with it when a link opens another", async ({
  page,
}) => {
  const board = await fakeBoard(page, { archived: true });
  // Each proposal's thread names the other, whose link opens it in the same view.
  for (const [id, other] of [
    [SKILL_PROPOSAL, ARCHIVE_PROPOSAL],
    [ARCHIVE_PROPOSAL, SKILL_PROPOSAL],
  ] as const) {
    await page.route(`**/api/threads/${id}`, (route) =>
      route.fulfill({
        json: {
          thread: {
            id,
            channel: "governance",
            title: `proposal ${id}`,
            subject: { kind: "proposal", id },
            state: "open",
            openedBy: "desk",
            openedAt: "2026-09-28T09:00:00.000Z",
            body: "",
          },
          messages: [
            {
              id: `${id.slice(0, -1)}Z`,
              author: "desk",
              channel: "governance",
              thread: id,
              ts: "2026-09-28T09:00:00.000Z",
              mentions: [],
              body: `Decide proposal ${other} too.`,
            },
          ],
        },
      }),
    );
  }
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);
  const box = page.getByRole("textbox", { name: "Write in the thread" });
  await expect(page.getByText("If approved: Publishes refereed-research")).toBeVisible();
  await page.locator(`article a[href="/proposal/${ARCHIVE_PROPOSAL}"]`).click();
  await expect(page.getByText("If approved: Archives lab")).toBeVisible();
  await box.fill("Not while its sign-off is in play.");
  // Back to the skill's, read already, so the view stays as it is and only its proposal changes.
  await page.locator(`article a[href="/proposal/${SKILL_PROPOSAL}"]`).click();
  await expect(page.getByText("If approved: Publishes refereed-research")).toBeVisible();
  await expect(box).toHaveValue("");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved by you")).toBeVisible();
  expect(board.writes).toEqual([
    { path: "/api/verbs/approve", body: { proposal_id: SKILL_PROPOSAL } },
  ]);
});

test("the board's refusal is shown in its own words and nothing changes", async ({ page }) => {
  const board = await fakeBoard(page);
  board.refuseNext(`proposal ${SKILL_PROPOSAL} is already provisioned`);
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  const box = page.getByRole("textbox", { name: "Write in the thread" });
  await box.fill("Four tasks are enough.");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    `proposal ${SKILL_PROPOSAL} is already provisioned`,
  );
  await expect(page.getByText("If approved:")).toBeVisible();
  // The reason stays in the box, with the keyboard there, and goes again from it.
  await expect(box).toHaveValue("Four tasks are enough.");
  await expect(box).toBeFocused();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved by you")).toBeVisible();
  expect(board.writes.map((write) => write.path)).toEqual([
    "/api/verbs/approve",
    "/api/verbs/approve",
  ]);
});

test("the pause switch pauses and resumes the society", async ({ page }) => {
  const board = await fakeBoard(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  expect(board.writes.map((write) => write.path)).toEqual(["/api/pause", "/api/resume"]);
});

test("needs you gathers a proposal, a stage that names the user, and a question asked in a thread", async ({
  page,
}) => {
  const board = await fakeBoard(page, { asked: true });
  await page.goto("/c/general");

  const needsYou = page.getByRole("region", { name: "Governance" }).getByRole("link", {
    name: /^needs you/,
  });
  await expect(needsYou).toHaveText("◉needs you3");
  await needsYou.click();
  await expect(page).toHaveURL(/\/needs-you$/);
  const view = page.getByRole("region", { name: "Board content" });
  await expect(view.getByRole("link", { name: /^Skill refereed-research/ })).toHaveAttribute(
    "href",
    `/proposal/${SKILL_PROPOSAL}`,
  );
  await expect(view.getByRole("link", { name: /Sign off \(gate\) in Lab/ })).toHaveAttribute(
    "href",
    `/task/${STAGE_TASK}`,
  );

  // A question is answered where it was asked: the task's thread. Answering there settles it.
  await view.getByRole("link", { name: /should the survey cover the 2025 results too/ }).click();
  await expect(page).toHaveURL(new RegExp(`/task/${STAGE_TASK}$`));
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  await box.fill("Yes, include 2025.");
  await box.press("Enter");
  await expect(needsYou).toHaveText("◉needs you2");
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/post_message",
    body: {
      thread_id: STAGE_TASK,
      body: "Yes, include 2025.",
      idempotency_key: expect.stringMatching(/^[0-9a-f]{32}$/),
    },
  });
});
