import { expect, test } from "@playwright/test";
import { ENROLLING_CODE, fakeBoard, TOKEN } from "./board.js";

test("a runner's link signs in with GitHub, comes back to the runner, and approves it", async ({
  page,
}) => {
  const board = await fakeBoard(page, { enrolling: true, github: true, signedOut: true });
  await page.goto(`/runners?code=${ENROLLING_CODE}`);

  // Signing in leaves for GitHub with the address to come back to.
  const github = page.getByRole("link", { name: "Sign in with GitHub" });
  await expect(github).toHaveAttribute(
    "href",
    `/auth/github?next=${encodeURIComponent(`/runners?code=${ENROLLING_CODE}`)}`,
  );

  // The server sends the browser back with the sign-in in the fragment, which the interface keeps
  // and drops from the address. It arrives from GitHub, so as a new document.
  await page.goto("about:blank");
  await page.goto(`/runners?code=${ENROLLING_CODE}#session=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "Runners" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.evaluate(() => localStorage.getItem("stellaris.token"))).toBe(TOKEN);
  // The top bar's Runners button is where the view opens from, with the runners waiting counted.
  const runners = page.getByRole("button", { name: "Runners, 1 waiting for approval" });
  await expect(runners).toHaveAttribute("aria-pressed", "true");
  await expect(runners).toContainText("1");
  await expect(page.getByRole("region", { name: "Governance" })).not.toContainText("runners");

  const form = page.getByRole("form", { name: "Approve Studio.local" });
  await expect(page.getByText(ENROLLING_CODE)).toBeVisible();
  await expect(form.getByLabel("Runner name")).toHaveValue("studio");
  await form.getByLabel("Runner name").fill("studio-mac");
  await form.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByText("None. A runner started")).toBeVisible();
  expect(board.writes).toEqual([
    { path: `/api/enrollments/${ENROLLING_CODE}/approve`, body: { name: "studio-mac" } },
  ]);
  await expect(page.getByRole("button", { name: "Runners", exact: true })).toBeVisible();
});

test("Runners in the top bar opens the runners view and closes it again", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/");
  const runners = page.getByRole("button", { name: "Runners", exact: true });
  await expect(runners).toHaveAttribute("aria-pressed", "false");
  await runners.click();
  await expect(page).toHaveURL("/runners");
  await expect(page.getByRole("heading", { name: "Runners" })).toBeVisible();
  await expect(runners).toHaveAttribute("aria-pressed", "true");
  await runners.click();
  await expect(page).toHaveURL("/");
});

test("a code nobody waits with says so, and a denial sends no name", async ({ page }) => {
  const board = await fakeBoard(page, { enrolling: true });
  await page.goto("/runners?code=ZZZZ-ZZZZ");
  await expect(page.getByText("No runner waits with the code ZZZZ-ZZZZ.")).toBeVisible();

  await page
    .getByRole("form", { name: "Approve Studio.local" })
    .getByRole("button", { name: "Deny" })
    .click();
  await expect(page.getByText("None. A runner started")).toBeVisible();
  expect(board.writes).toEqual([{ path: `/api/enrollments/${ENROLLING_CODE}/deny`, body: {} }]);
});

test("a refused GitHub sign-in says why, and a board without GitHub asks for a token alone", async ({
  page,
}) => {
  await fakeBoard(page, { github: true, signedOut: true });
  await page.goto("/#signin-error=not-allowed");
  await expect(page.getByRole("alert")).toHaveText(
    "That GitHub account is not allowed on this board.",
  );
  expect(new URL(page.url()).hash).toBe("");

  const tokens = await page.context().newPage();
  await fakeBoard(tokens, { signedOut: true });
  await tokens.goto("/");
  await expect(tokens.getByRole("button", { name: "Enter the playground" })).toBeVisible();
  await expect(tokens.getByRole("link", { name: "Sign in with GitHub" })).toHaveCount(0);
});
