import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

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
});
