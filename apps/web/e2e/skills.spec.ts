import { expect, test, type Locator, type Page } from "@playwright/test";
import { fakeBoard } from "./board.js";

const CREATED = "2026-10-01T09:00:00.000Z";
const LONG =
  "Applies to every repository the society works in: how a change is cut into commits, what each commit message says, which checks run before a push, where the evidence for a change goes, and what the reviewer reruns before it passes, with the reasons for each rule so that a new citizen can follow it without asking.";

/** The lines a box shows, from its height and its line height. */
async function linesOf(box: Locator): Promise<{ shown: number; cut: boolean }> {
  return box.evaluate((element) => {
    const height = element.getBoundingClientRect().height;
    const line = Number.parseFloat(getComputedStyle(element).lineHeight);
    return {
      shown: Math.round(height / line),
      cut: element.scrollHeight > element.clientHeight + 1,
    };
  });
}

/** Each row's preview under its name: a topic's first paragraph or a skill's summary. */
function previewOf(page: Page, name: RegExp): Locator {
  return page
    .getByRole("region", { name: "Board content" })
    .getByRole("link", { name })
    .locator(":scope > span")
    .nth(1);
}

test("a society skill opens from the society's overview with its SKILL.md and each file beside it", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/society");
  const view = page.getByRole("region", { name: "Board content" });
  const society = page.getByRole("navigation").getByRole("link", { name: "Society", exact: true });
  await expect(society).toHaveClass(/(^| )text-fg-primary( |$)/);

  // The overview lists the skill as a link, as it lists knowledge, with nothing to press beside it.
  const link = view.getByRole("link", { name: /^uv-setup/ });
  await expect(link).toContainText("Set up a uv project with locked dependencies");
  await expect(view.getByRole("button", { name: /uv-setup/ })).toHaveCount(0);
  await link.click();

  await expect(page).toHaveURL(/\/skills\/uv-setup$/);
  await expect(view.getByRole("heading", { name: "uv-setup" })).toBeVisible();
  // The name and the summary may be cut in the header, so hovering each shows it whole.
  await expect(view.locator("header h2 span[title]")).toHaveAttribute("title", "uv-setup");
  await expect(view.locator("header p span[title]")).toHaveAttribute(
    "title",
    "Set up a uv project with locked dependencies",
  );
  await expect(view.locator("header")).toContainText(
    "Set up a uv project with locked dependencies",
  );
  // The society stays the navigator's place while one of its skills is open.
  await expect(society).toHaveClass(/(^| )text-fg-primary( |$)/);
  await expect(view.getByText("Run scripts/check.sh before the first commit.")).toBeVisible();
  await expect(view.getByText("name: uv-setup")).toHaveCount(0);

  // SKILL.md is the text above, not a row of its own among the files.
  await expect(view.getByRole("button", { name: /SKILL\.md/ })).toHaveCount(0);
  const script = view.getByRole("button", { name: /scripts\/check\.sh/ });
  await expect(script).toContainText("27 B · executable");
  await expect(view.getByRole("button", { name: /references\/flags\.md/ })).toContainText("18 B");
  await expect(script).toHaveAttribute("aria-expanded", "false");
  await expect(view.getByText("uv sync --locked")).toHaveCount(0);
  await script.click();
  await expect(script).toHaveAttribute("aria-expanded", "true");
  await expect(view.getByText("uv sync --locked")).toBeVisible();

  await view.getByRole("button", { name: "Back to the society" }).click();
  await expect(page).toHaveURL(/\/society$/);
  await expect(view.getByRole("link", { name: /^uv-setup/ })).toBeVisible();
});

test("a skill opened by its address goes back to the society, and one that is gone says so", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/skills/uv-setup");
  const view = page.getByRole("region", { name: "Board content" });
  await expect(view.getByText("Run scripts/check.sh before the first commit.")).toBeVisible();
  await view.getByRole("link", { name: "Back to the society" }).click();
  await expect(page).toHaveURL(/\/society$/);

  await page.goto("/skills/uv-project");
  await expect(view).toContainText("The society has no skill uv-project.");
});

test("a society skill is removed from its page with a reason, and the society lists it no more", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  // The skill's files are gone with it, so nothing asks for them once it is removed.
  let removed = false;
  let filesAfter = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/verbs/remove_skill")) {
      removed = true;
    } else if (removed && request.url().endsWith("/api/skills/uv-setup/files")) {
      filesAfter += 1;
    }
  });
  await page.goto("/society");
  const view = page.getByRole("region", { name: "Board content" });
  await view.getByRole("link", { name: /^uv-setup/ }).click();
  await expect(view.getByText("Run scripts/check.sh before the first commit.")).toBeVisible();

  // Cancel puts the form away and removes nothing.
  await view.getByRole("button", { name: "Remove…" }).click();
  const form = page.getByRole("form", { name: "Remove uv-setup" });
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);

  // The first click asks for a reason and says what removing does; only the second removes.
  await view.getByRole("button", { name: "Remove…" }).click();
  await expect(form).toContainText("No citizen's skills index lists uv-setup");
  await expect(view.getByRole("button", { name: "Remove…" })).toHaveCount(0);
  const confirm = form.getByRole("button", { name: "Remove skill" });
  await expect(confirm).toBeDisabled();
  await expect(form.getByRole("textbox", { name: "Reason" })).toBeFocused();
  await form.getByRole("textbox", { name: "Reason" }).fill("Superseded by uv-project");
  expect(board.writes).toEqual([]);
  await confirm.click();

  await expect(page).toHaveURL(/\/society$/);
  await expect(view.getByRole("link", { name: /^uv-setup/ })).toHaveCount(0);
  await expect(view).toContainText("None yet. A citizen's skill joins the society by proposal.");
  expect(board.writes).toEqual([
    {
      path: "/api/verbs/remove_skill",
      body: { name: "uv-setup", reason: "Superseded by uv-project" },
    },
  ]);
  expect(filesAfter).toBe(0);
});

test("a skill whose files fail to load says so under its header, and a 404 is not asked again", async ({
  page,
}) => {
  await fakeBoard(page);
  let status = 500;
  let asked = 0;
  await page.route("**/api/skills/uv-setup/files", async (route) => {
    asked += 1;
    await route.fulfill({ status, json: { error: "INTERNAL", message: "the disk is gone" } });
  });
  const view = page.getByRole("region", { name: "Board content" });
  await page.goto("/skills/uv-setup");
  await expect(view).toContainText("Could not read its files.");
  await expect(view.getByRole("heading", { name: "uv-setup" })).toBeVisible();
  await expect(view.getByRole("button", { name: "Remove…" })).toBeVisible();

  // A skill gone since the list was read answers 404 once; the error shows after that one ask.
  status = 404;
  asked = 0;
  await page.goto("/skills/uv-setup");
  await expect(view).toContainText("Could not read its files.");
  expect(asked).toBe(1);
});

test("the society's knowledge and skill previews stop at two lines, at a wide and a narrow window", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.route("**/api/society/knowledge", (route) =>
    route.fulfill({
      json: [
        {
          topic: "commit-rules",
          project: null,
          revision: 1,
          updatedBy: "stew",
          updatedAt: CREATED,
          body: `# Commit rules\n\n${LONG}`,
        },
        {
          topic: "short-note",
          project: null,
          revision: 1,
          updatedBy: "stew",
          updatedAt: CREATED,
          body: "One line.",
        },
      ],
    }),
  );
  await page.route("**/api/skills", (route) =>
    route.fulfill({
      json: [
        {
          name: "long-summary",
          summary: LONG,
          scope: "society",
          path: "/data/society/skills/long-summary/SKILL.md",
        },
        {
          name: "short-summary",
          summary: "One line.",
          scope: "society",
          path: "/data/society/skills/short-summary/SKILL.md",
        },
      ],
    }),
  );
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/society");
    for (const name of [/^commit-rules/, /^long-summary/]) {
      await expect(previewOf(page, name)).toBeVisible();
      expect(await linesOf(previewOf(page, name)), `${name} at ${width}`).toEqual({
        shown: 2,
        cut: true,
      });
    }
    for (const name of [/^short-note/, /^short-summary/]) {
      expect(await linesOf(previewOf(page, name)), `${name} at ${width}`).toEqual({
        shown: 1,
        cut: false,
      });
    }
  }
});
