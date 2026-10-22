import { expect, test } from "@playwright/test";
import { fakeBoard, STAGE_TASK } from "./board.js";

test("a path a citizen wrote through a task's worktree opens the file from the task's branch", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = page.getByRole("region", { name: "Board content" });
  const thread = view.getByRole("region", { name: "Thread" });
  // A path on another machine reads as text, since nothing on the board can open it.
  await expect(thread).toContainText("my scratch notes are in notes.");
  await expect(thread.getByRole("link", { name: "notes" })).toHaveCount(0);

  const report = thread.getByRole("link", { name: "report.md" });
  await expect(report).toHaveAttribute("href", `/task/${STAGE_TASK}/files/docs/report.md`);
  await report.click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files/docs/report.md`);
  await expect(view.getByRole("heading", { name: "report.md" })).toBeVisible();
  await expect(view).toContainText("committed by ada");
  await expect(view).toContainText("4f2a9c1");
  await expect(view).toContainText("Dijkstra wins on sparse graphs.");
  // The report's figure sits beside it on the branch and shows in place.
  const figure = view.getByRole("img", { name: "Runtime by graph size" });
  await expect(figure).toBeVisible();
  await expect.poll(() => figure.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);

  await view.getByRole("link", { name: "the table" }).click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files/results.csv`);
  await expect(view.getByRole("columnheader", { name: "method" })).toBeVisible();
  await expect(view.getByRole("cell", { name: "A*, tuned" })).toBeVisible();
  await expect(view.getByRole("link", { name: "Download" })).toHaveAttribute(
    "download",
    "results.csv",
  );

  await view.getByRole("navigation", { name: "Path" }).getByRole("link", { name: "Files" }).click();
  await expect(view.getByRole("link", { name: "docs/" })).toBeVisible();
  await expect(view.getByRole("link", { name: "results.csv" })).toBeVisible();

  await page.goto(`/task/${STAGE_TASK}/files/draft.md`);
  await expect(view).toContainText(`draft.md is not on task/${STAGE_TASK} yet`);
  await view.getByRole("link", { name: /Back to the task/ }).click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}`);
});

test("a task's view lists the files its branch changed, each opening to its patch and from there to the file", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = page.getByRole("region", { name: "Board content" });
  const files = view.getByRole("region", { name: "Files" });
  await expect(files).toContainText("4 files changed · newest commit by ada");
  await expect(files).toContainText("new · +7");
  await expect(files).toContainText("+2 −1");
  await expect(files).toContainText("new · binary");

  // Files sit under their folders, which open and close; a small change opens whole.
  const docs = files.getByRole("button", { name: /^docs\// });
  await expect(docs).toHaveAttribute("aria-expanded", "true");
  await expect(docs).toContainText("2 files");
  const report = files.getByRole("button", { name: /^report\.md/ });
  await expect(report).toBeVisible();
  await docs.click();
  await expect(docs).toHaveAttribute("aria-expanded", "false");
  await expect(report).toHaveCount(0);
  await docs.click();

  // A file opens to what the branch did to it, and closes again.
  const results = files.getByRole("button", { name: /^results\.csv/ });
  await expect(results).toHaveAttribute("aria-expanded", "false");
  await results.click();
  await expect(results).toHaveAttribute("aria-expanded", "true");
  await expect(files).toContainText("-Dijkstra,1.4");
  await expect(files).toContainText('+"A*, tuned",0.9');
  // Each line the file has links to it at that line, the removed one not.
  await expect(files.getByTitle("Open results.csv at line 3")).toHaveAttribute(
    "href",
    `/task/${STAGE_TASK}/files/results.csv?line=3`,
  );
  await expect(files.getByTitle(/^Open results\.csv at line/)).toHaveCount(3);
  await results.click();
  await expect(files).not.toContainText("-Dijkstra,1.4");

  // A deleted file shows what it held, with no file to open; a binary one says so.
  await files.getByRole("button", { name: /^draft\.md/ }).click();
  await expect(files).toContainText("-Bellman-Ford first.");
  await files.getByRole("button", { name: /^plot\.png/ }).click();
  await expect(files).toContainText("A binary file; its contents are not shown here.");
  await expect(files.getByRole("link", { name: "Open the whole file" })).toHaveCount(1);

  await results.click();
  await files.getByRole("link", { name: "Open the whole file" }).last().click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files/results.csv`);
  await expect(view.getByRole("cell", { name: "A*, tuned" })).toBeVisible();

  await view.getByRole("button", { name: "Back to Compare shortest-path algorithms" }).click();
  await view
    .getByRole("region", { name: "Files" })
    .getByRole("link", { name: "Browse the branch" })
    .click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files`);
  await expect(view.getByRole("link", { name: "docs/" })).toBeVisible();
});

test("a link that cites a line opens the file at that line, marked", async ({ page }) => {
  await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = page.getByRole("region", { name: "Board content" });
  const thread = view.getByRole("region", { name: "Thread" });
  await thread.getByRole("link", { name: "table's citation" }).click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files/docs/report.md?line=7`);
  await expect(view).toContainText("line 7");
  await expect(view.locator(".line-target")).toHaveText("The raw numbers are in the table.");

  // An address from before cited lines were split off opens the same way.
  await page.goto(`/task/${STAGE_TASK}/files/docs/report.md%3A3`);
  await expect(view.locator(".line-target")).toHaveText("Dijkstra wins on sparse graphs.");

  // Text gets its lines numbered, and the cited one marked.
  await page.goto(`/task/${STAGE_TASK}/files/docs/run.log?line=2`);
  await expect(view.locator(".line-target")).toHaveText("2second line");
});

test("the back arrow returns to the view it came from, named, and to the parent only when there is none", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);
  const view = page.getByRole("region", { name: "Board content" });

  // The thread's link to the report, then the report's figure.
  await view
    .getByRole("region", { name: "Thread" })
    .getByRole("link", { name: "report.md" })
    .click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files/docs/report.md`);
  await view
    .getByRole("link")
    .filter({ has: page.getByRole("img", { name: "Runtime by graph size" }) })
    .click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files/docs/plot.png`);

  await view.getByRole("button", { name: "Back to report.md" }).click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files/docs/report.md`);
  await view.getByRole("button", { name: "Back to Compare shortest-path algorithms" }).click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}`);

  // The first view of the tab has nowhere to return to, so its arrow goes up to its parent.
  await view.getByRole("link", { name: "Back to the tasks of Lab" }).click();
  await expect(page).toHaveURL("/p/lab/tasks");

  // So does a view opened from a link, in a tab of its own.
  const fresh = await page.context().newPage();
  await fakeBoard(fresh);
  await fresh.goto(`/task/${STAGE_TASK}/files/docs/plot.png`);
  await fresh
    .getByRole("region", { name: "Board content" })
    .getByRole("link", { name: "Back to the task Compare shortest-path algorithms" })
    .click();
  await expect(fresh).toHaveURL(`/task/${STAGE_TASK}`);
});

test("a project's view lists the top of its default branch, each file opening in the files view", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/p/lab");
  const view = page.getByRole("region", { name: "Board content" });
  const files = view
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^Files/ }) });

  await expect(files).toContainText("main · committed by ref");
  await expect(files).toContainText("9b1d3e7");
  // Folders first, then files, each by name; a file with its size.
  await expect(files.getByRole("listitem")).toHaveText([
    /docs\/$/,
    /^README\.md\s*\d+ B$/,
    /^seeds\.csv\s*\d+ B$/,
  ]);

  // A file opens in the files view, its relative links staying on the project's branch.
  await files.getByRole("link", { name: "README.md" }).click();
  await expect(page).toHaveURL("/p/lab/files/README.md");
  await expect(view.getByRole("heading", { name: "README.md" })).toBeVisible();
  await expect(view).toContainText("Lab · main · committed by ref");
  const methods = view.getByRole("link", { name: "the methods" });
  await expect(methods).toHaveAttribute("href", "/p/lab/files/docs/methods.md");
  await methods.click();
  await expect(view.getByRole("heading", { name: "methods.md" })).toBeVisible();
  await view.getByRole("link", { name: "the list" }).click();
  await expect(page).toHaveURL("/p/lab/files/seeds.csv");
  await expect(view.getByRole("cell", { name: "small" })).toBeVisible();

  // In the files view a folder is a page of its own, and the arrows return the way they came.
  await page.goto("/p/lab");
  await files.getByRole("link", { name: "Browse the branch" }).click();
  await expect(page).toHaveURL("/p/lab/files");
  await view.getByRole("link", { name: "docs/" }).click();
  await expect(page).toHaveURL("/p/lab/files/docs");
  await expect(view.getByRole("link", { name: "methods.md" })).toBeVisible();
  await view.getByRole("button", { name: "Back to the files of Lab", exact: true }).click();
  await expect(page).toHaveURL("/p/lab/files");
  await view.getByRole("button", { name: "Back to Lab", exact: true }).click();
  await expect(page).toHaveURL("/p/lab");

  // Opened as a tab's first view, a path the branch lacks says so, and the arrow goes up.
  await page.goto("/p/lab/files/notes.md");
  await expect(view).toContainText("notes.md is not on main.");
  await view.getByRole("link", { name: "Back to the project Lab" }).click();
  await expect(page).toHaveURL("/p/lab");
  await page.goto("/p/nothing/files/README.md");
  await expect(view).toContainText("There is no project nothing.");
});

test("a project's folders open in place, as a task's tree does, and its files open in the files view", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/p/lab");
  const view = page.getByRole("region", { name: "Board content" });
  const files = view
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^Files/ }) });
  const docs = files.getByRole("button", { name: "docs/" });
  const methods = files.getByRole("link", { name: "methods.md" });
  await expect(docs).toHaveAttribute("aria-expanded", "false");
  await expect(methods).toHaveCount(0);

  // A folder unfolds under itself, its folders first, and the page stays where it is.
  await docs.click();
  await expect(docs).toHaveAttribute("aria-expanded", "true");
  await expect(methods).toBeVisible();
  await expect(page).toHaveURL("/p/lab");
  const archive = files.getByRole("button", { name: "archive/" });
  await expect(archive).toHaveAttribute("aria-expanded", "false");
  // A folder inside opens the same way, read when it first opens.
  await archive.click();
  await expect(files.getByRole("link", { name: "pilot.md" })).toBeVisible();

  // Folding a folder hides what is under it, and opening it again shows what was open there.
  await docs.click();
  await expect(docs).toHaveAttribute("aria-expanded", "false");
  await expect(methods).toHaveCount(0);
  await expect(files.getByRole("link", { name: "pilot.md" })).toHaveCount(0);
  await docs.click();
  await expect(files.getByRole("link", { name: "pilot.md" })).toBeVisible();

  // A file opens in the files view.
  await methods.click();
  await expect(page).toHaveURL("/p/lab/files/docs/methods.md");
  await expect(view.getByRole("heading", { name: "methods.md" })).toBeVisible();
});

test("a project's files follow a change of its default branch, in the section and the files view", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/p/lab");
  const view = page.getByRole("region", { name: "Board content" });
  const files = view
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^Files/ }) });
  await expect(files.getByRole("link", { name: "README.md" })).toBeVisible();

  // An open folder reads the new branch too.
  const docs = files.getByRole("button", { name: "docs/" });
  await docs.click();
  await expect(files.getByRole("link", { name: "methods.md" })).toBeVisible();
  await view.getByRole("button", { name: "Edit…" }).click();
  await view.getByRole("textbox", { name: "Default branch" }).fill("next");
  await view.getByRole("button", { name: "Save" }).click();
  await expect(files).toContainText("next · committed by ref");
  await expect(files).toContainText("5e6f7a8");
  await expect(docs).toHaveAttribute("aria-expanded", "true");
  await expect(files.getByRole("link", { name: "plan.md" })).toBeVisible();
  await expect(files.getByRole("link", { name: "methods.md" })).toHaveCount(0);

  await view.getByRole("button", { name: "Edit…" }).click();
  await view.getByRole("textbox", { name: "Default branch" }).fill("trunk");
  await view.getByRole("button", { name: "Save" }).click();
  // The clone has no trunk until a turn there, so nothing of main's shows under trunk's name.
  await expect(files).toContainText("Nothing on trunk yet.");
  await expect(files.getByRole("link", { name: "README.md" })).toHaveCount(0);
  await files.getByRole("link", { name: "Browse the branch" }).click();
  await expect(page).toHaveURL("/p/lab/files");
  await expect(view).toContainText("Nothing on trunk yet.");
  await expect(view.getByRole("link", { name: "README.md" })).toHaveCount(0);
});

test("a project's files say when its runner is away and when its branch holds nothing", async ({
  page,
}) => {
  await fakeBoard(page);
  let answer: { status: number; json: unknown } = {
    status: 503,
    json: { error: "RUNNER_AWAY", message: "runner laptop, where lab lives, is not connected" },
  };
  // Registered after the fake board, so it answers first.
  await page.route("**/api/projects/lab/files", (route) => route.fulfill(answer));
  await page.goto("/p/lab");
  const view = page.getByRole("region", { name: "Board content" });
  const files = view
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^Files/ }) });
  await expect(files).toContainText(
    "laptop, the runner Lab lives on, is not connected, so the project's files cannot be listed now.",
  );

  const commit = {
    id: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    at: new Date().toISOString(),
    author: "ref",
  };
  answer = { status: 200, json: { kind: "dir", path: "", commit, entries: [] } };
  await page.reload();
  await expect(files).toContainText("main · committed by ref");
  await expect(files).toContainText("Nothing on main yet.");

  answer = { status: 404, json: { error: "NOT_FOUND", message: "lab has no repository yet" } };
  await page.reload();
  await expect(files).toContainText("Nothing on main yet.");
  await expect(files).not.toContainText("committed by");
});
