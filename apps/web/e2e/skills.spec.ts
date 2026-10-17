import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

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
  // The summary may be cut in the header, so hovering it shows it whole.
  await expect(view.locator("header span[title]")).toHaveAttribute(
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
});
