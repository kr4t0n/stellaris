import { expect, test, type Page, type Route } from "@playwright/test";
import { ARCHIVE_PROPOSAL, SKILL_PROPOSAL, STAGE_TASK, fakeBoard } from "./board.js";

const DESK_TURN = "01M3Q2DDDDDDDDDDDDDDDDDDD2";

function viewOf(page: Page) {
  return page.getByRole("region", { name: "Board content" });
}

function refuse(route: Route): Promise<void> {
  return route.fulfill({ status: 500, json: { error: "INTERNAL", message: "disk full" } });
}

/**
 * The views a read that fails before they have anything to show left saying they were reading, or
 * of a turn that it kept no steps, while the read kept failing, and for good where it doesn't poll:
 * where each is, its read, and what it now says it could not read.
 */
const FAILED_READS: ReadonlyArray<{
  readonly view: string;
  readonly address: string;
  readonly read: string;
  readonly open?: string;
  readonly note: string;
}> = [
  {
    view: "a task",
    address: `/task/${STAGE_TASK}`,
    read: `/api/tasks/${STAGE_TASK}`,
    note: "the task",
  },
  {
    view: "a proposal",
    address: `/proposal/${SKILL_PROPOSAL}`,
    read: `/api/proposals/${SKILL_PROPOSAL}`,
    note: "the proposal",
  },
  {
    view: "a channel",
    address: "/c/lab/general",
    read: "/api/channels/lab/general",
    note: "the channel",
  },
  {
    view: "a citizen's core memory",
    address: "/citizen/desk?tab=memory",
    read: "/api/agents/desk/memory",
    note: "the core memory",
  },
  {
    view: "a citizen's own skills",
    address: "/citizen/desk?tab=memory",
    read: "/api/agents/desk/skills",
    note: "its skills",
  },
  {
    view: "a citizen's last turn",
    address: "/citizen/desk",
    read: `/api/agents/desk/turns/${DESK_TURN}`,
    note: "the last turn",
  },
  {
    view: "a citizen's turns",
    address: "/citizen/desk?tab=turns",
    read: "/api/agents/desk/turns",
    note: "the turns",
  },
  {
    view: "a turn's steps",
    address: `/citizen/desk?tab=turns&turn=${DESK_TURN}`,
    read: `/api/agents/desk/turns/${DESK_TURN}`,
    note: "the steps",
  },
  {
    view: "a citizen's runner form",
    address: "/citizen/desk",
    read: "/api/runners",
    open: "Runner…",
    note: "the runners",
  },
  { view: "the society", address: "/society", read: "/api/society", note: "the society" },
  { view: "the society's skills", address: "/society", read: "/api/skills", note: "the skills" },
  {
    view: "the society's knowledge",
    address: "/society",
    read: "/api/society/knowledge",
    note: "the knowledge",
  },
  { view: "a skill", address: "/skills/uv-setup", read: "/api/skills", note: "the skills" },
  {
    view: "a project's tasks",
    address: "/p/lab",
    read: "/api/projects/lab/tasks",
    note: "the tasks",
  },
  {
    view: "a project's dashboard",
    address: "/p/lab",
    read: "/api/projects/lab/dashboard",
    note: "the dashboard",
  },
  {
    view: "a project's knowledge",
    address: "/p/lab",
    read: "/api/projects/lab/knowledge",
    note: "the knowledge",
  },
  {
    view: "a project's runner form",
    address: "/p/lab",
    read: "/api/runners",
    open: "Runner…",
    note: "the runners",
  },
  {
    view: "a knowledge topic",
    address: "/knowledge/lab/experiments",
    read: "/api/projects/lab/knowledge",
    note: "the topic",
  },
  {
    view: "the tasks",
    address: "/p/lab/tasks",
    read: "/api/projects/lab/tasks",
    note: "the tasks",
  },
  {
    view: "an archive proposal's tasks in play",
    address: `/proposal/${ARCHIVE_PROPOSAL}`,
    read: "/api/projects/lab/tasks",
    note: "the tasks",
  },
  { view: "the proposals", address: "/proposals", read: "/api/proposals", note: "the proposals" },
  { view: "the runners", address: "/runners", read: "/api/runners", note: "the runners" },
  { view: "the operations log", address: "/logs", read: "/api/signals", note: "the log" },
];

for (const { view, address, read, open, note } of FAILED_READS) {
  test(`${view} whose read fails says it could not read ${note}`, async ({ page }) => {
    await fakeBoard(page);
    await page.route((url) => url.pathname === read, refuse);
    await page.goto(address);
    if (open !== undefined) {
      await viewOf(page).getByRole("button", { name: open }).click();
    }
    await expect(viewOf(page)).toContainText(`Could not read ${note}: disk full`);
  });
}

test("a read that polls says it failed until its next answer, and a later failure keeps what it shows", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.clock.install();
  let failing = true;
  let asked = 0;
  await page.route(
    (url) => url.pathname === "/api/projects/lab/tasks",
    (route) => {
      asked += 1;
      return failing ? refuse(route) : route.fallback();
    },
  );
  const view = viewOf(page);
  await page.goto("/p/lab/tasks");
  await expect(view).toContainText("Could not read the tasks: disk full");

  // The tasks are read again every minute, and the first answer takes the note away. The clock
  // jumps, firing each timer due once, since running the sky's every frame for a minute is slow.
  failing = false;
  await page.clock.fastForward(60_000);
  await expect(view).toContainText("Compare shortest-path algorithms");
  await expect(view).not.toContainText("Could not read");

  // A read that fails once the tasks are shown, and its one retry, leave them as they were.
  failing = true;
  const before = asked;
  await page.clock.fastForward(60_000);
  await expect.poll(() => asked).toBe(before + 1);
  await page.clock.fastForward(2_000);
  await expect.poll(() => asked).toBe(before + 2);
  await expect(view).toContainText("Compare shortest-path algorithms");
  await expect(view).not.toContainText("Could not read");
});

test("a turn the board kept no steps of still says so", async ({ page }) => {
  await fakeBoard(page);
  await page.route(
    (url) => url.pathname === `/api/agents/desk/turns/${DESK_TURN}`,
    (route) =>
      route.fulfill({ status: 404, json: { error: "NOT_FOUND", message: "no transcript" } }),
  );
  await page.goto(`/citizen/desk?tab=turns&turn=${DESK_TURN}`);
  await expect(viewOf(page)).toContainText("No steps were kept for this turn.");
});
