import { expect, test } from "@playwright/test";
import { DESK_TURN_IN_FLIGHT, fakeBoard, STAGE_TASK } from "./board.js";

test("a citizen's turns and memory are tabs of its view", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/citizen/desk?tab=turns");

  const view = page.getByRole("region", { name: "Board content" });
  await expect(view).toContainText("1 turn · $0.25");
  await expect(view).toContainText("Routed the survey request to ada and filed the task.");
  await expect(view).toContainText("3m · 4 tools · $0.25");

  await view.getByRole("link", { name: "Memory" }).click();
  await expect(page).toHaveURL(/\/citizen\/desk\?tab=memory$/);
  await expect(view).toContainText("The user writes names plainly.");
  await expect(view).toContainText("routing · Send a post to who can act on it.");
  await expect(view).toContainText("Charter of concierge");
  // A conflict copy two of its turns left waits at the top until the citizen reconciles it.
  await expect(view.getByRole("heading", { name: "Edits to reconcile" })).toBeVisible();
  await expect(view).toContainText("memory/core.md · core.md.conflict-0000ABCD · left 2 days ago");
});

test("a finished turn opens to every tool call with what it returned", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/citizen/desk?tab=turns");
  const view = page.getByRole("region", { name: "Board content" });

  await view.getByText("lab", { exact: true }).click();
  await expect(view).toContainText("Looking at the request.");
  await expect(view).toContainText("2 tool calls");
  await expect(view.locator("summary", { hasText: "ls lab/bench" })).toBeVisible();
  await expect(view.getByText("Returned an error")).toBeHidden();

  await view.getByRole("button", { name: "Expand all" }).click();
  await expect(view.getByText("Returned an error")).toBeVisible();
  await expect(view).toContainText("ls: cannot access 'lab/bench': No such file or directory");
  await expect(view).toContainText('{"id":"01M3Q2AAAAAAAAAAAAAAAAAAA1"}');
});

test("a home's history opens each change to its patch and to the turn that made it", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/citizen/desk");
  const view = page.getByRole("region", { name: "Board content" });
  await view.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/citizen\/desk\?tab=history$/);

  const turn = view.locator("summary", {
    hasText: "memory/core.md +1 −0, skills/routing/SKILL.md new",
  });
  await expect(turn).toContainText("turn");
  await expect(view.locator("summary", { hasText: "board" })).toContainText("memory/core.md new");
  await turn.click();
  const added = view.getByText("+- The user writes names plainly.");
  await expect(added).toBeVisible();
  await expect(added).toHaveClass(/text-emerald-300/);
  await expect(view).toContainText("+description: Send a post to who can act on it.");

  // The change names its turn, which opens in the Turns tab with its steps.
  await view.getByRole("link", { name: "Open the turn that made it" }).click();
  await expect(page).toHaveURL(/\/citizen\/desk\?tab=turns&turn=01M3Q2DDDDDDDDDDDDDDDDDDD2$/);
  await expect(view).toContainText("Looking at the request.");
  await expect(view.locator("summary", { hasText: "ls lab/bench" })).toBeVisible();
});

test("a turn in flight takes a post into its conversation, and stops on a second click", async ({
  page,
}) => {
  const board = await fakeBoard(page, { inFlight: true });
  await page.goto("/citizen/desk");
  const view = page.getByRole("region", { name: "Board content" });
  const box = view.getByLabel("Message desk while it works");
  await expect(box).toHaveValue("@desk ");
  await box.fill("@desk also check the runners");
  await expect(view.getByText("Sending reaches desk in the turn under way.")).toBeVisible();
  await box.press("Enter");
  await expect
    .poll(() => board.writes.find((write) => write.path === "/api/verbs/post_message")?.body)
    .toEqual({ channel: "general", body: "@desk also check the runners" });
  await expect(box).toHaveValue("@desk ");

  // The first click says what stopping does; only the second stops.
  await view.getByRole("button", { name: "Stop…" }).click();
  await expect(view).toContainText("What it was shown counts as read");
  expect(board.writes.some((write) => write.path.endsWith("/stop"))).toBe(false);
  await view.getByRole("button", { name: "Stop the turn" }).click();
  await expect
    .poll(() => board.writes.map((write) => write.path))
    .toContain(`/api/turns/${DESK_TURN_IN_FLIGHT}/stop`);
  // The turn is no longer in flight, so its controls go.
  await expect(view.getByRole("button", { name: "Stop…" })).toBeHidden();
  await expect(view.getByLabel("Message desk while it works")).toBeHidden();
});

test("after a restart the Now tab shows the last turn from its transcript", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/citizen/desk");
  const view = page.getByRole("region", { name: "Board content" });
  await expect(view).toContainText("Last turn · lab");
  await expect(view.getByText("create_task")).toBeVisible();
  await expect(view).toContainText("The turn completed");
});

test("a citizen's model is chosen from its CLI's list and shows until its next turn", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/citizen/desk");
  const view = page.getByRole("region", { name: "Board content" });
  await expect(view).toContainText("concierge · claude-opus-5-5");

  await view.getByRole("button", { name: "Model…" }).click();
  const form = page.getByRole("form", { name: "Model of desk" });
  const picker = form.getByRole("button", { name: /^Model: / });
  await expect(picker).toHaveAccessibleName("Model: CLI default · Opus 5.5");
  await expect(form.getByRole("button", { name: "Use this model" })).toBeDisabled();

  await picker.click();
  await expect(form).toContainText("Efficient for routine tasks.");
  // Escape closes the list, not the board.
  await page.keyboard.press("Escape");
  await expect(form).not.toContainText("Efficient for routine tasks.");
  await expect(page).toHaveURL(/\/citizen\/desk$/);

  await picker.click();
  await form.getByRole("button", { name: /^Sonnet 5/ }).click();
  await expect(picker).toHaveAccessibleName("Model: Sonnet 5 · sonnet");
  await form.getByRole("button", { name: "Use this model" }).click();

  await expect(form).toHaveCount(0);
  await expect(view).toContainText("concierge · claude-opus-5-5 · set to sonnet");
  expect(board.writes).toEqual([{ path: "/api/agents/desk/model", body: { model: "sonnet" } }]);
});

test("a citizen's work outside projects is moved to another runner, or left to be pinned again", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/citizen/desk");
  const view = page.getByRole("region", { name: "Board content" });
  await expect(view).toContainText("concierge · claude-opus-5-5 · on pod");

  await view.getByRole("button", { name: "Runner…" }).click();
  const form = page.getByRole("form", { name: "Runner of desk" });
  const picker = form.getByRole("button", { name: /^Runner: / });
  await expect(picker).toHaveAccessibleName("Runner: pod · linux");
  await expect(form.getByRole("button", { name: "Run here" })).toBeDisabled();
  await expect(form).toContainText("memory and skills follow it");

  await picker.click();
  await expect(form).toContainText("disconnected · claude · gpu");
  await form.getByRole("button", { name: /^laptop/ }).click();
  await form.getByRole("button", { name: "Run here" }).click();
  await expect(form).toHaveCount(0);
  await expect(view).toContainText("concierge · claude-opus-5-5 · on laptop");

  await view.getByRole("button", { name: "Runner…" }).click();
  await page
    .getByRole("form", { name: "Runner of desk" })
    .getByRole("button", { name: /^Runner: / })
    .click();
  await page.getByRole("button", { name: /^Any runner/ }).click();
  await page.getByRole("button", { name: "Run here" }).click();
  await expect(view).not.toContainText(" · on ");
  expect(board.writes).toEqual([
    { path: "/api/agents/desk/runner", body: { runner: "laptop" } },
    { path: "/api/agents/desk/runner", body: { runner: null } },
  ]);
});

test("waking a citizen says what it does and sends the wake the scheduler takes", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/citizen/desk");

  await page.getByRole("button", { name: "Wake…" }).click();
  const form = page.getByRole("form", { name: "Wake desk" });
  await form.getByText("A reflection").click();
  await form.getByLabel("Where").selectOption("society");
  await expect(form).toContainText("Asks desk to reflect at the society");
  await form.getByLabel("Reason").fill("the routing lesson from today");
  await form.getByRole("button", { name: "Ask for a reflection" }).click();

  await expect(form).toHaveCount(0);
  expect(board.writes).toEqual([
    {
      path: "/api/wake",
      body: {
        agent: "desk",
        project: "society",
        kind: "reflection",
        reason: "the routing lesson from today",
      },
    },
  ]);
});

test("a project's overview shows its members, tasks, dashboard, and knowledge", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Board" }).click();
  await page.getByRole("link", { name: "Lab", exact: true }).click();

  await expect(page).toHaveURL(/\/p\/lab$/);
  const view = page.getByRole("region", { name: "Board content" });
  await expect(view.getByRole("link", { name: /desk/ })).toContainText("resting");
  await expect(view).toContainText("1 waiting for a holder");
  await expect(view.getByRole("heading", { name: "Lab dashboard" })).toBeVisible();

  await view.getByRole("link", { name: /experiments/ }).click();
  await expect(page).toHaveURL(/\/knowledge\/lab\/experiments$/);
  await expect(view).toContainText("Knowledge of Lab · written by ada");
  await expect(view).toContainText("The harness lives in bench/.");

  // An id in the text reads as what it names and links to it; a branch name stays as written.
  const settled = view.getByRole("link", { name: "Compare shortest-path algorithms" });
  await expect(settled).toHaveAttribute("title", `task ${STAGE_TASK}`);
  await expect(view).toContainText(`its branch is task/${STAGE_TASK}.`);
  await settled.click();
  await expect(page).toHaveURL(new RegExp(`/task/${STAGE_TASK}$`));
});

test("the citizen count opens every citizen with its role and model, and each opens its view", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/");
  const count = page.getByRole("button", { name: "2 citizens" });
  await count.click();
  await expect(page).toHaveURL(/\/citizens$/);
  await expect(count).toHaveAttribute("aria-pressed", "true");

  const view = page.getByRole("region", { name: "Board content" });
  await expect(view.getByRole("heading", { name: "Citizens" })).toBeVisible();
  await expect(view).toContainText("2 active in 2 roles");
  const desk = view.getByRole("link", { name: /^desk/ });
  await expect(desk).toContainText("concierge");
  await expect(desk).toContainText("claude-opus-5-5");
  await expect(desk).toContainText("lab");
  await expect(desk).toContainText("resting");
  // Its work outside projects runs where it is pinned, and its work in lab where lab lives.
  await expect(desk.getByText("on pod, laptop")).toHaveAttribute(
    "title",
    "outside projects: pod; lab: laptop",
  );
  const stew = view.getByRole("link", { name: /^stew/ });
  await expect(stew).toContainText("steward");
  await expect(stew).toContainText("no projects");
  // In no project, and not pinned until its first turn outside one.
  await expect(stew).toContainText("no runner yet");

  await desk.click();
  await expect(page).toHaveURL(/\/citizen\/desk$/);
  await count.click();
  await expect(page).toHaveURL(/\/citizens$/);
  await count.click();
  await expect(page).toHaveURL(/\/$/);
});
