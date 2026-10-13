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
  // The society has a runner called studio already.
  await expect(form.getByLabel("Runner name")).toHaveValue("studio-2");
  await form.getByLabel("Runner name").fill("studio-mac");
  await form.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByText("A runner started with STELLARIS_SERVER_URL")).toBeVisible();
  expect(board.writes).toEqual([
    { path: `/api/enrollments/${ENROLLING_CODE}/approve`, body: { name: "studio-mac" } },
  ]);
  await expect(page.getByRole("button", { name: "Runners", exact: true })).toBeVisible();
});

for (const late of ["enrollments", "runners"] as const) {
  test(`the suggested name skips the society's runners when the ${late} answer last`, async ({
    page,
  }) => {
    await fakeBoard(page, { enrolling: true });
    const { promise: held, resolve: answer } = Promise.withResolvers<void>();
    // Registered after the fake board, so it answers first and holds one list back.
    await page.route(`**/api/${late}`, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto("/runners");
    const name = page.getByRole("form", { name: "Approve Studio.local" }).getByLabel("Runner name");
    if (late === "runners") {
      // Until the runners are known, nothing is taken.
      await expect(page.getByText("Reading the runners…")).toBeVisible();
      await expect(name).toHaveValue("studio");
    } else {
      await expect(
        page.getByRole("list", { name: "Registered" }).getByRole("listitem"),
      ).toHaveCount(3);
      await expect(name).toHaveCount(0);
    }
    answer();
    await expect(name).toHaveValue("studio-2");
  });
}

test("the suggested name follows the runners list as it changes, and a typed one stays", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true });
  // Registered after the fake board, so they answer first: the runners as the test lists them, and
  // the board's event stream, which says a runner was added each time the test adds one.
  const names = ["pod", "studio"];
  await page.route("**/api/runners", (route) =>
    route.fulfill({
      json: names.map((name) => ({
        name,
        os: "linux",
        clis: ["claude"],
        capabilities: [],
        status: "connected",
      })),
    }),
  );
  let announce = Promise.withResolvers<void>();
  await page.route("**/api/events/stream**", async (route) => {
    await announce.promise;
    announce = Promise.withResolvers<void>();
    const event = {
      id: `01M3Q2EEEEEEEEEEEEEEEEEEE${names.length}`,
      ts: "2026-10-13T12:00:00.000Z",
      type: "runner.added",
      actor: "user",
      payload: { name: names.at(-1) },
    };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(event)}\n\n`,
    });
  });
  const add = (runner: string): void => {
    names.push(runner);
    announce.resolve();
  };
  await page.goto("/runners");
  const rows = page.getByRole("list", { name: "Registered" }).getByRole("listitem");
  const form = page.getByRole("form", { name: "Approve Studio.local" });
  const name = form.getByLabel("Runner name");
  await expect(name).toHaveValue("studio-2");

  add("studio-2");
  await expect(rows).toHaveCount(3);
  await expect(name).toHaveValue("studio-3");

  await name.fill("mac-studio");
  add("studio-3");
  await expect(rows).toHaveCount(4);
  await expect(name).toHaveValue("mac-studio");
  // An emptied field is the user's too, so the suggestion does not come back to fill it.
  await name.fill("");
  await expect(name).toHaveValue("");
  await expect(form.getByRole("button", { name: "Approve" })).toBeDisabled();
});

test("Runners in the top bar opens the runners view and closes it again", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/");
  const runners = page.getByRole("button", { name: "Runners", exact: true });
  await expect(runners).toHaveAttribute("aria-pressed", "false");
  await runners.click();
  await expect(page).toHaveURL("/runners");
  await expect(page.getByRole("heading", { name: "Runners" })).toBeVisible();
  await expect(
    page.getByText(
      "2 connected · 1 away · server v0.3.11 · 1 on another version · 1 without a git identity",
    ),
  ).toBeVisible();
  // One row each, in columns, connected first; a runner away says so in words, not a dot, one on
  // another release than the server's is marked, and so is one whose account has no git identity,
  // under its name, while one with an identity and one that never said, from before runners
  // checked, are not.
  const rows = page.getByRole("list", { name: "Registered" }).getByRole("listitem");
  await expect(rows).toHaveText([
    /^claude, codex\s*pod\s*no git user\.email\s*linux\s*v0\.3\.11\s*no projects\s*connected$/,
    /^claude\s*studio\s*darwin\s*v0\.3\.11\s*no projects\s*connected$/,
    /^claude\s*laptop\s*darwin\s*v0\.3\.10, not the server's v0\.3\.11\s*gpu\s*lab\s*away$/,
  ]);
  // Every row keeps the same seven cells, so each column holds the same thing.
  const cells = (row: number) => rows.nth(row).locator(":scope > *");
  for (const row of [0, 1, 2]) {
    await expect(cells(row)).toHaveCount(7);
  }
  await expect(cells(2)).toHaveText([
    /claude/,
    "laptop",
    "darwin",
    /^v0\.3\.10/,
    "gpu",
    "lab",
    "away",
  ]);
  await expect(rows.nth(2).getByText("away")).toHaveClass(/text-amber-300/);
  await expect(rows.nth(2).getByText("v0.3.10")).toHaveClass(/text-amber-300/);
  await expect(rows.nth(0).getByText("v0.3.11")).not.toHaveClass(/text-amber-300/);
  const gap = cells(0).nth(1).getByText("no git user.email");
  await expect(gap).toHaveClass(/text-amber-300/);
  await expect(gap).toHaveAttribute("title", /carry an empty address or one git made up/);
  await expect(cells(1).nth(1)).toHaveText("studio");
  await expect(page.getByText("●")).toHaveCount(0);
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
  await expect(page.getByText("A runner started with STELLARIS_SERVER_URL")).toBeVisible();
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
