import { expect, test, type Page } from "@playwright/test";

const url = (): string => {
  const value = process.env["E2E_URL"];
  if (value === undefined) throw new Error("E2E_URL is not set; the global setup did not run");
  return value;
};
const token = (): string => {
  const value = process.env["E2E_TOKEN"];
  if (value === undefined) throw new Error("E2E_TOKEN is not set; the global setup did not run");
  return value;
};

async function signIn(page: Page): Promise<void> {
  await page.goto(`${url()}/login`);
  await page.getByLabel("Owner token").fill(token());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("world-canvas").locator("canvas")).toBeVisible();
}

async function call(verb: string, input: unknown): Promise<void> {
  const response = await fetch(`${url()}/api/verbs/${verb}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`${verb} failed: ${await response.text()}`);
}

/**
 * The Phase 7 exit criterion. The owner drives the mention, review, merge flow through the
 * drawers and watches the world follow: the citizen walks into its plot, the crop ripens on
 * review, the harvest lands on merge, and the mailbox flag rises when a proposal arrives. The
 * world's states are read from the keyboard mirror, which names the same entities the canvas draws.
 */
test("the owner watches a task grow from mention to harvest on the world", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await signIn(page);
  const mirror = page.getByTestId("world-mirror");
  await expect(mirror).toContainText("eng-1, engineer on claude: at home");
  await expect(mirror).toContainText("rev-1, reviewer on claude: at home");
  await expect(mirror).toContainText("Demo: 2 member(s); no tasks; 0 harvest(s)");
  await expect(mirror).toContainText("Clock: running");
  await page.screenshot({ path: "e2e/output/01-world.png" });

  // A task is a seed in the plot.
  await page.goto(`${url()}/projects/demo/tasks`);
  await expect(page.getByTestId("drawer")).toBeVisible();
  await page.getByLabel("Title").fill("Add hello.txt");
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(mirror).toContainText("Add hello.txt seed");
  await page.getByRole("link", { name: "Add hello.txt" }).first().click();
  const idLine = await page.getByText(/^id [0-9A-HJKMNP-TV-Z]{26}$/).textContent();
  const taskId = (idLine ?? "").replace("id ", "");
  expect(taskId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  await page.screenshot({ path: "e2e/output/02-seed.png" });

  // The mention wakes the engineer: it walks into the plot and works beside its crop.
  await page.goto(`${url()}/projects/demo/channels/general`);
  await page
    .getByPlaceholder(/Write a message/)
    .fill(`@eng-1 please take task ${taskId}: add hello.txt with a greeting.`);
  await page.getByRole("button", { name: /Post to demo\/general/ }).click();
  const log = page.getByTestId("world-log");
  await expect(log).toContainText("eng-1, engineer on claude: working in demo", {
    timeout: 30_000,
  });
  await page.screenshot({ path: "e2e/output/03-working.png" });

  // Submitted for review, the crop is ripe; the reviewer comes to inspect it. Transient states are
  // read from the mirror's change log, which keeps them after the world has moved on.
  await expect(log).toContainText("Add hello.txt ripe", { timeout: 30_000 });
  await page.screenshot({ path: "e2e/output/04-ripe.png" });

  // Approved and merged by the board, the harvest lands in the barn.
  await expect(log).toContainText("Add hello.txt harvested", { timeout: 30_000 });
  await expect(mirror).toContainText("1 harvest(s)", { timeout: 30_000 });
  await expect(mirror).toContainText("eng-1, engineer on claude: at home", { timeout: 30_000 });
  await page.screenshot({ path: "e2e/output/05-harvest.png" });

  // A proposal arrives: the mailbox flag goes up and the town hall has a notice.
  await call("propose", {
    kind: "channel",
    charter: { project: "demo", name: "design", purpose: "Design talk" },
    rationale: "The owner wants a place for design.",
  });
  await expect(page.getByTestId("mailbox-flag")).toBeVisible({ timeout: 15_000 });
  await expect(mirror).toContainText("Town hall: 1 proposal(s) to decide", { timeout: 15_000 });
  await page.goto(`${url()}/`);
  await expect(page.getByTestId("drawer")).toHaveCount(0);
  await page.screenshot({ path: "e2e/output/06-mailbox.png" });

  // The drawers still open from the keyboard mirror and the palette.
  await page.getByRole("button", { name: /^Demo:/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("drawer")).toContainText("Demo");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("drawer")).toHaveCount(0);

  expect(errors).toEqual([]);
});
