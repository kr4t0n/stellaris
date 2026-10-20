import { expect, type Locator, test } from "@playwright/test";
import { DESK_TURN_IN_FLIGHT, fakeBoard, STAGE_TASK } from "./board.js";

/** Where an element is on the page, failing when it is not shown. */
async function boxOf(element: Locator) {
  const box = await element.boundingBox();
  if (box === null) {
    throw new Error("an element is not on the page");
  }
  return box;
}

/**
 * Where an element's text is drawn, leaving out text only screen readers get: a cell's own box
 * spans its whole column, wherever its text sits in it.
 */
function textBoxOf(element: Locator) {
  return element.evaluate((node) => {
    const range = document.createRange();
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
      if (text.parentElement?.closest(".sr-only") === null) {
        range.selectNodeContents(text);
        rects.push(...range.getClientRects());
      }
    }
    if (rects.length === 0) {
      throw new Error("no text is drawn");
    }
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
}

/**
 * Whether the cell holding an element of a citizen's row keeps its text on one line however
 * narrow the other columns leave its own: its narrowest width is its whole width.
 */
function isUnbreakable(element: Locator): Promise<boolean> {
  return element.evaluate((node) => {
    const cell = node.closest("a > *");
    if (!(cell instanceof HTMLElement)) {
      return false;
    }
    const width = cell.style.width;
    cell.style.width = "min-content";
    const narrowest = cell.getBoundingClientRect().width;
    cell.style.width = "max-content";
    const widest = cell.getBoundingClientRect().width;
    cell.style.width = width;
    return widest - narrowest < 0.5;
  });
}

/** How many lines an element's text is drawn on. */
function lineCountOf(element: Locator): Promise<number> {
  return element.evaluate((node) => {
    const tops = new Set<number>();
    const range = document.createRange();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
      range.selectNodeContents(text);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0) {
          tops.add(Math.round(rect.top));
        }
      }
    }
    return tops.size;
  });
}

/**
 * How far the Citizens list runs past its island, in pixels, as its scroller could scroll sideways:
 * the list and each row are as wide as the columns together, so neither overflows itself.
 */
function sidewaysOf(view: Locator): Promise<number> {
  return view
    .locator("ul")
    .first()
    .evaluate((list) => {
      const scroller = list.parentElement?.parentElement;
      return scroller === null || scroller === undefined
        ? Number.NaN
        : scroller.scrollWidth - scroller.clientWidth;
    });
}

/** How many pixels of its text the cell holding an element of a citizen's row cuts off. */
function cutOf(element: Locator): Promise<number> {
  return element.evaluate((node) => {
    const cell = node.closest("a > *");
    return cell === null ? Number.NaN : cell.scrollWidth - cell.clientWidth;
  });
}

/**
 * Whether an element in a citizen's row shows all of its text: its cell cuts none of it, and it
 * ends inside the row.
 */
function isWhole(element: Locator): Promise<boolean> {
  return element.evaluate((node) => {
    const cell = node.closest("a > *");
    const row = node.closest("a");
    if (cell === null || row === null) {
      return false;
    }
    const box = node.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    return (
      cell.scrollWidth <= cell.clientWidth && box.left >= bounds.left && box.right <= bounds.right
    );
  });
}

/**
 * Where a row's counts are drawn, from their text: the in count's right edge, the separator after
 * it, and the out count, leaving out what only screen readers get.
 */
function countsOf(cell: Locator) {
  return cell.evaluate((node) => {
    const texts: Text[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
      if (text instanceof Text && text.parentElement?.closest(".sr-only") === null) {
        texts.push(text);
      }
    }
    const input = texts.find((text) => text.data.includes(" in ·"));
    const output = texts.findLast((text) => text.data.includes(" out"));
    if (input === undefined || output === undefined) {
      throw new Error("no counts are drawn");
    }
    const range = document.createRange();
    const box = (text: Text, from: number, to: number) => {
      range.setStart(text, from);
      range.setEnd(text, to);
      return range.getBoundingClientRect();
    };
    const dot = input.data.indexOf("·");
    const inBox = box(input, 0, input.data.indexOf(" in") + 3);
    const dotBox = box(input, dot, dot + 1);
    const from = output === input ? input.data.indexOf("· ") + 2 : 0;
    const outBox = box(output, from, output.data.indexOf(" out") + 4);
    // Generated content drawn anywhere in the cell, which only its own text should be.
    const drawn = [node, ...node.querySelectorAll("*")].filter((each) => {
      const before = getComputedStyle(each, "::before");
      return before.visibility === "visible" && !["none", "normal"].includes(before.content);
    }).length;
    return {
      drawn,
      height: node.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
      top: inBox.top,
      inRight: inBox.right,
      dotLeft: dotBox.left,
      dotRight: dotBox.right,
      outTop: outBox.top,
      outLeft: outBox.left,
      outRight: outBox.right,
    };
  });
}

/** How far apart the furthest of some values are. */
function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

/**
 * Checks that counted rows' in counts end at one x, and their out counts too, and that the widest
 * out count starts a space after the separator, as wide a space as the one before it, while the
 * others start further on; and that each row's counts are one line of their own text.
 */
async function expectAligned(cells: readonly Locator[]) {
  const counts = await Promise.all(cells.map((cell) => countsOf(cell)));
  expect(spread(counts.map((each) => each.inRight)), "in counts' right edges").toBeLessThan(1);
  expect(spread(counts.map((each) => each.outRight)), "out counts' right edges").toBeLessThan(1);
  for (const each of counts) {
    expect(Math.abs(each.top - each.outTop)).toBeLessThanOrEqual(1);
    expect(each.height).toBeLessThanOrEqual(each.lineHeight + 1);
    expect(each.drawn).toBe(0);
  }
  const before = counts.map((each) => each.dotLeft - each.inRight);
  const after = counts.map((each) => each.outLeft - each.dotRight);
  expect(spread(before)).toBeLessThan(0.5);
  expect(Math.abs(Math.min(...after) - (before[0] ?? Number.NaN))).toBeLessThan(0.5);
}

test("a citizen's turns and memory are tabs of its view", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/citizen/desk?tab=turns");

  const view = page.getByRole("region", { name: "Board content" });
  await expect(view.getByText("1 turn · 151K in · 1.5K out", { exact: true })).toBeVisible();
  await expect(view).toContainText("Routed the survey request to ada and filed the task.");
  await expect(view.getByText("3m · 4 tools · 151K in · 1.5K out", { exact: true })).toBeVisible();
  // Turns read the same on either CLI: tokens, never dollars, which Codex does not report.
  await expect(view).not.toContainText("$");
  await expect(view.getByTitle(/^151,361 input tokens: 146,048 read from the cache/)).toHaveCount(
    2,
  );

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
  await expect(view.getByText("Posts reach the turn at its next step.")).toBeVisible();
  await box.press("Enter");
  await expect
    .poll(() => board.writes.find((write) => write.path === "/api/verbs/post_message")?.body)
    .toEqual({ channel: "general", body: "@desk also check the runners" });
  await expect(box).toHaveValue("@desk ");

  // The first click asks again; only the second stops.
  await view.getByRole("button", { name: "Stop…" }).click();
  await expect(view.getByRole("button", { name: "Keep it running" })).toBeVisible();
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
  // The choices are the CLI's on the runner desk's turns run on, which the form names.
  await expect(form).toContainText("Listed by claude on pod");
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();

  await picker.click();
  await expect(form).toContainText("Efficient for routine tasks.");
  // Escape closes the list, not the board.
  await page.keyboard.press("Escape");
  await expect(form).not.toContainText("Efficient for routine tasks.");
  await expect(page).toHaveURL(/\/citizen\/desk$/);

  await picker.click();
  await form.getByRole("button", { name: /^Sonnet 5/ }).click();
  await expect(picker).toHaveAccessibleName("Model: Sonnet 5 · sonnet");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(form).toHaveCount(0);
  await expect(view).toContainText("concierge · claude-opus-5-5 · set to sonnet");
  expect(board.writes).toEqual([{ path: "/api/agents/desk/model", body: { model: "sonnet" } }]);
});

test("a citizen's reasoning effort is chosen from its model's levels, and a model without it drops it", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/citizen/desk");
  const view = page.getByRole("region", { name: "Board content" });
  await view.getByRole("button", { name: "Model…" }).click();
  const form = page.getByRole("form", { name: "Model of desk" });
  const effort = form.getByRole("button", { name: /^Effort: / });
  // The CLI's default model is Opus, whose default effort is high.
  await expect(effort).toHaveAccessibleName("Effort: Default · high");

  await effort.click();
  await expect(form).toContainText("Maximum effort");
  await form.getByRole("button", { name: /^max/ }).click();
  await expect(effort).toHaveAccessibleName("Effort: max");
  // Sonnet has no max, so choosing it goes back to the model's default.
  const picker = form.getByRole("button", { name: /^Model: / });
  await picker.click();
  await form.getByRole("button", { name: /^Sonnet 5/ }).click();
  await expect(effort).toHaveAccessibleName("Effort: Default · high");
  await picker.click();
  await form.getByRole("button", { name: /^CLI default/ }).click();
  await effort.click();
  await form.getByRole("button", { name: /^max/ }).click();
  await form.getByRole("button", { name: "Save" }).click();

  await expect(form).toHaveCount(0);
  await expect(view).toContainText("concierge · claude-opus-5-5 · max effort");
  // Only what changed is written: the model stayed the CLI's default.
  expect(board.writes).toEqual([{ path: "/api/agents/desk/effort", body: { effort: "max" } }]);
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

test("waking a citizen sends the wake the scheduler takes", async ({ page }) => {
  const board = await fakeBoard(page);
  await page.goto("/citizen/desk");

  await page.getByRole("button", { name: "Wake…" }).click();
  const form = page.getByRole("form", { name: "Wake desk" });
  await form.getByText("A reflection").click();
  // The board's own picker, not the browser's.
  await form.getByRole("button", { name: "Where: lab" }).click();
  await form.getByRole("button", { name: /^the society/ }).click();
  await expect(form.locator("select")).toHaveCount(0);
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

test("a society knowledge topic is removed from its page after a second click", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/society");
  const view = page.getByRole("region", { name: "Board content" });
  await view.getByRole("link", { name: /code-comments/ }).click();
  await expect(page).toHaveURL(/\/knowledge\/society\/code-comments$/);
  await expect(view).toContainText("Comment only what the code cannot say.");

  // The first click asks again; only the second removes.
  await view.getByRole("button", { name: "Remove…" }).click();
  const form = page.getByRole("form", { name: "Remove the topic" });
  await expect(form).toHaveText(/^\s*Remove code-comments\?\s*Cancel\s*Remove topic\s*$/);
  expect(board.writes).toEqual([]);
  await form.getByRole("button", { name: "Remove topic" }).click();

  await expect(page).toHaveURL(/\/society$/);
  await expect(view.getByRole("link", { name: /code-comments/ })).toHaveCount(0);
  await expect(view).toContainText("No knowledge yet.");
  expect(board.writes).toEqual([
    { path: "/api/verbs/remove_knowledge", body: { project: null, topic: "code-comments" } },
  ]);
});

test("a project's name and default branch are edited from its page, and its slug stays", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/p/lab");
  const view = page.getByRole("region", { name: "Board content" });
  await view.getByRole("button", { name: "Edit…" }).click();
  const form = page.getByRole("form", { name: "Edit lab" });
  const name = form.getByRole("textbox", { name: "Project name" });
  const branch = form.getByRole("textbox", { name: "Default branch" });
  await expect(name).toHaveValue("Lab");
  await expect(branch).toHaveValue("main");
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  await name.fill("Shortest paths lab");
  await branch.fill("trunk");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(form).toHaveCount(0);
  await expect(view.getByRole("heading", { name: "Shortest paths lab" })).toBeVisible();
  await expect(view).toContainText("lab · a local repository · trunk");
  await expect(page).toHaveURL(/\/p\/lab$/);
  await expect(page.getByRole("link", { name: "Shortest paths lab", exact: true })).toBeVisible();
  // Only what changed is sent, in one call.
  expect(board.writes).toEqual([
    {
      path: "/api/verbs/configure_project",
      body: { project: "lab", name: "Shortest paths lab", default_branch: "trunk" },
    },
  ]);
});

test("a citizen's view and the citizens list say when its CLI's quota is at its limit", async ({
  page,
}) => {
  await fakeBoard(page, { quotas: "limited" });
  await page.goto("/citizens");
  const view = page.getByRole("region", { name: "Board content" });
  // desk's turns run on pod, where Claude is limited, so its CLI is marked, in words for readers.
  const mark = view.getByTitle(/^claude limited for (39|40)m on pod$/);
  await expect(mark).toBeVisible();
  await expect(mark).toHaveText(/claude limited for (39|40)m on pod/);

  await page.goto("/citizen/desk");
  const quota = view.locator("p", { hasText: /^claude quota/ });
  await expect(quota).toContainText(/pod limited for (39|40)m/);
  await expect(quota).toContainText("laptop 5h 35% · 7d 12%");
  await quota.getByRole("link", { name: "claude quota" }).click();
  await expect(page).toHaveURL("/runners");
  await expect(
    page.getByRole("region", { name: "Plan quota" }).getByText(/^limited for (39|40)m · as of/),
  ).toBeVisible();
});

test("the citizens list shows each citizen's tokens over a window, retired ones apart", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await fakeBoard(page, { retired: true, crowded: true });
  await page.goto("/citizens");
  const view = page.getByRole("region", { name: "Board content" });
  const row = (name: string) =>
    view.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
  const window = view.getByRole("navigation", { name: "Tokens" });

  // The last day by default: desk's one counted turn, as its Turns tab adds it up.
  await expect(window.getByRole("link", { name: "24h" })).toHaveAttribute("aria-current", "page");
  await expect(row("desk")).toContainText("151K in · 1.5K out");
  await expect(
    row("desk").getByTitle(/^151,361 input tokens: 146,048 read from the cache/),
  ).toHaveAttribute("title", /; over 1 finished turn in the last 24 hours$/);
  await expect(row("stew")).toContainText("no turns");
  const retired = view.getByRole("region", { name: "Retired" });
  await expect(retired.getByRole("heading", { name: "Retired" })).toBeVisible();
  await expect(retired.getByRole("listitem")).toHaveCount(1);
  await expect(row("ada")).toContainText("retired");
  await expect(row("ada")).toContainText("no turns");

  // The island is 420 px wide, too narrow for the counts beside the rest: they take a line under
  // the row, ending under its state, with no separator, and nothing is cut or runs out of the list.
  for (const [name, label, word] of [
    ["desk", "151K in · 1.5K out", "resting"],
    ["stew", "no turns", "resting"],
    ["ada", "no turns", "retired"],
  ] as const) {
    const counts = row(name).getByText(label);
    const state = row(name).getByText(word, { exact: true });
    const [countsBox, stateBox] = await Promise.all([textBoxOf(counts), textBoxOf(state)]);
    expect(Math.abs(countsBox.x + countsBox.width - stateBox.x - stateBox.width)).toBeLessThan(1);
    expect(countsBox.y).toBeGreaterThanOrEqual(stateBox.y + stateBox.height - 1);
    expect(await isWhole(counts)).toBe(true);
    expect(await isWhole(state)).toBe(true);
    await expect(row(name).getByText("·", { exact: true })).toBeHidden();
  }
  expect(await sidewaysOf(view)).toBe(0);

  // A week holds turns without a count: the counts of those that have one, which the hover and
  // screen readers say, and unknown where none counted.
  await window.getByRole("link", { name: "7d" }).click();
  await expect(page).toHaveURL(/\/citizens\?window=7d$/);
  await expect(window.getByRole("link", { name: "7d" })).toHaveAttribute("aria-current", "page");
  await expect(row("desk")).toContainText("151K in · 1.5K out");
  await expect(row("desk")).not.toContainText("≥");
  await expect(row("desk").getByRole("link")).toHaveAccessibleName(
    /over 1 of 3 finished turns in the last 7 days/,
  );
  await expect(row("desk").getByTitle(/The other 2 have no count/)).toBeVisible();
  await expect(row("stew")).toContainText("tokens unknown");
  await expect(
    row("stew").getByTitle(/^2 finished turns in the last 7 days, none with a token count/),
  ).toBeVisible();

  await window.getByRole("link", { name: "All" }).click();
  await expect(page).toHaveURL(/\/citizens\?window=all$/);
  await expect(row("desk")).toContainText("7.4M in · 42K out");
  await expect(row("stew")).toContainText("7.2M in · 40K out");
  await expect(row("ada")).toContainText("88K in · 900 out");
  await expect(view.getByText(/≥/)).toHaveCount(0);
});

test("from a 576 px island, each citizen's tokens sit beside its state, and the model, runners, and projects share what is left", async ({
  page,
}) => {
  // 1440 px gives the island 576 px. desk is in a turn, its model and projects run long, and its
  // turns run on two runners named as the chart names its pods, as stew's do on one.
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeBoard(page, { retired: true, crowded: true, inFlight: true });
  const { promise: counted, resolve: count } = Promise.withResolvers<void>();
  await page.route("**/api/tokens**", async (route) => {
    await counted;
    await route.fallback();
  });
  await page.goto("/citizens");
  const view = page.getByRole("region", { name: "Board content" });
  const row = (name: string) =>
    view.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });

  // Each row's counts and state share a line, neither cut nor able to wrap, a space's width apart
  // around the separator, and the counts end where the other rows' do, and the states start where
  // theirs do.
  const oneLine = async (rows: ReadonlyArray<readonly [string, string | RegExp, string]>) => {
    const ends: number[] = [];
    const starts: number[] = [];
    const withCounts: Locator[] = [];
    for (const [name, label, word] of rows) {
      const counts = row(name).getByText(label);
      const separator = row(name).getByText("·", { exact: true });
      const state = row(name).getByText(word, { exact: true });
      await expect(separator).toBeVisible();
      const [countsBox, dotBox, stateBox] = await Promise.all([
        textBoxOf(counts),
        textBoxOf(separator),
        textBoxOf(state),
      ]);
      expect(Math.abs(countsBox.y - stateBox.y)).toBeLessThanOrEqual(1);
      expect(dotBox.x - countsBox.x - countsBox.width).toBeGreaterThanOrEqual(0);
      expect(dotBox.x - countsBox.x - countsBox.width).toBeLessThan(8);
      expect(stateBox.x).toBeGreaterThanOrEqual(dotBox.x + dotBox.width);
      expect(await isWhole(counts)).toBe(true);
      expect(await isWhole(state)).toBe(true);
      expect(await isUnbreakable(state)).toBe(true);
      ends.push(countsBox.x + countsBox.width);
      starts.push(stateBox.x);
      if (/ in · /.test(String(label))) {
        withCounts.push(counts);
      }
    }
    expect(Math.max(...ends) - Math.min(...ends)).toBeLessThan(1);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(1);
    if (withCounts.length > 0) {
      await expectAligned(withCounts);
    }
  };

  // While the counts load, and once they are in.
  await expect(row("desk")).toContainText("counting…");
  await oneLine([
    ["desk", "counting…", "working"],
    ["stew", "counting…", "resting"],
    ["ada", "counting…", "retired"],
  ]);
  count();
  await expect(row("desk")).toContainText("151K in · 1.5K out");
  await oneLine([
    ["desk", "151K in · 1.5K out", "working"],
    ["stew", "no turns", "resting"],
    ["ada", "no turns", "retired"],
  ]);
  // The state keeps its tone and its own hover, and the counts theirs.
  const working = row("desk").getByText("working", { exact: true });
  await expect(working).toHaveClass(/text-emerald-300/);
  await expect(working).toHaveAttribute("title", "in a turn at the society");
  await expect(row("desk").getByText("151K in · 1.5K out")).toHaveAttribute(
    "title",
    /^151,361 input tokens: 146,048 read from the cache/,
  );
  // The separator is not read out: the row's name is as it was.
  await expect(row("desk").getByRole("link")).toHaveAccessibleName(/151K in · 1\.5K out working$/);

  // The model, runners, and projects give way, sharing what is left alike, each cut on one line,
  // and nothing runs out of the list.
  const model = row("desk").getByTitle("claude-opus-5-5 · set to opus · xhigh");
  const runners = row("desk").getByTitle(/^outside projects: stellaris-runner-0; lab:/);
  const projects = row("desk").getByTitle("lab, atlas, beacon, comet");
  const widths: number[] = [];
  for (const cell of [model, runners, projects]) {
    expect(await cutOf(cell)).toBeGreaterThan(0);
    expect(await lineCountOf(cell)).toBe(1);
    widths.push((await boxOf(cell)).width);
  }
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(12);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  expect(await sidewaysOf(view)).toBe(0);
  // Every runner is read out whole, and named on hover with the work that runs on it.
  await expect(runners).toHaveText("on stellaris-runner-0, stellaris-runner-1");
  await expect(runners).toHaveAttribute(
    "title",
    "outside projects: stellaris-runner-0; lab: stellaris-runner-1; atlas: placed on its first turn; beacon: placed on its first turn; comet: placed on its first turn",
  );

  // Some turns without a count, a count unknown, and the widest counts still fit beside the state.
  const window = view.getByRole("navigation", { name: "Tokens" });
  await window.getByRole("link", { name: "7d" }).click();
  await expect(row("stew")).toContainText("tokens unknown");
  await oneLine([
    ["desk", /^151K in · 1\.5K out/, "working"],
    ["stew", "tokens unknown", "resting"],
    ["ada", "no turns", "retired"],
  ]);
  await expect(row("desk").getByRole("link")).toHaveAccessibleName(
    /over 1 of 3 finished turns in the last 7 days/,
  );
  await window.getByRole("link", { name: "All" }).click();
  await expect(row("desk")).toContainText("7.4M in · 42K out");
  // Every count differs in width from row to row, in and out, and hal's out count is the widest.
  const allTime = [
    ["desk", /^7\.4M in · 42K out/, "working"],
    ["hal", "950K in · 1.5M out", "resting"],
    ["stew", /^7\.2M in · 40K out/, "resting"],
    ["ada", "88K in · 900 out", "retired"],
  ] as const;
  await oneLine(allTime);
  expect(await sidewaysOf(view)).toBe(0);

  // The island's width decides, not the window's: narrowed a step, the counts go under the row,
  // and widened back, beside the state again.
  const handle = page.getByRole("button", { name: /^Width of the board's content/ });
  await handle.press("ArrowRight");
  await expect(handle).toHaveAccessibleName(/^Width of the board's content, 544 of/);
  const separator = row("desk").getByText("·", { exact: true });
  await expect(separator).toBeHidden();
  const [under, beside] = await Promise.all([
    textBoxOf(row("desk").getByText(/^7\.4M in · 42K out/)),
    textBoxOf(row("desk").getByText("working", { exact: true })),
  ]);
  expect(under.y).toBeGreaterThanOrEqual(beside.y + beside.height - 1);
  expect(Math.abs(under.x + under.width - beside.x - beside.width)).toBeLessThan(1);
  await handle.press("ArrowLeft");
  await expect(separator).toBeVisible();
  await oneLine(allTime);
});

test("each citizen's in and out counts line up down the list, beside the state and under the row", async ({
  page,
}) => {
  await fakeBoard(page, { retired: true, crowded: true });
  const view = page.getByRole("region", { name: "Board content" });
  const row = (name: string) =>
    view.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
  const handle = page.getByRole("button", { name: /^Width of the board's content/ });
  // Over all time each count's width differs from row to row, in and out, and hal's out count is
  // the widest.
  const counted = [
    ["desk", "7.4M in · 42K out"],
    ["hal", "950K in · 1.5M out"],
    ["stew", "7.2M in · 40K out"],
    ["ada", "88K in · 900 out"],
  ] as const;
  for (const [width, island] of [
    [1440, 576],
    [1024, 420],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/citizens?window=all");
    await expect(handle).toHaveAccessibleName(
      new RegExp(`^Width of the board's content, ${island} of`),
    );
    const cells = counted.map(([name, label]) => row(name).getByText(label));
    for (const cell of cells) {
      await expect(cell).toBeVisible();
      await expect(cell).toHaveCSS("font-variant-numeric", "tabular-nums");
    }
    await expectAligned(cells);
    // What sizes the out counts adds nothing a reader or a copy picks up, and no mark is shown.
    await expect(row("hal").getByText("950K in · 1.5M out")).toHaveText("950K in · 1.5M out");
    await expect(row("hal").getByRole("link")).toHaveAccessibleName(
      /investigator .* 950K in · 1\.5M out resting$/,
    );
    await expect(view.getByText(/≥/)).toHaveCount(0);
    expect(await sidewaysOf(view)).toBe(0);
  }
});

test("under the row, the counts take no room from the row above them", async ({ page }) => {
  // Under the row the counts span it from the name's column on, so no column above them grows to
  // hold them: desk's out count is wider than any state's word, and laid out in the state's column
  // it would widen that column and take room from the model and runners.
  await page.addInitScript(() => localStorage.setItem("stellaris.contentWidth", "490"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeBoard(page, { retired: true, crowded: true });
  await page.goto("/citizens?window=24h");
  const view = page.getByRole("region", { name: "Board content" });
  const row = (name: string) =>
    view.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
  await expect(
    page.getByRole("button", { name: /^Width of the board's content/ }),
  ).toHaveAccessibleName(/^Width of the board's content, 490 of/);
  const counts = row("desk").getByText("151K in · 1.5K out");
  await expect(counts).toBeVisible();
  const [countsBox, nameBox] = await Promise.all([
    boxOf(counts),
    boxOf(row("desk").getByText("desk", { exact: true })),
  ]);
  expect(Math.abs(countsBox.x - nameBox.x)).toBeLessThan(1);
  // The state's column is as wide as its widest word.
  const states = [
    row("desk").getByText("resting", { exact: true }),
    row("hal").getByText("resting", { exact: true }),
    row("stew").getByText("resting", { exact: true }),
    row("ada").getByText("retired", { exact: true }),
  ];
  const words = await Promise.all(states.map((state) => textBoxOf(state)));
  const column = await states[0]?.evaluate(
    (node) => node.closest("a > *")?.getBoundingClientRect().width ?? Number.NaN,
  );
  expect((column ?? Number.NaN) - Math.max(...words.map((word) => word.width))).toBeLessThan(1);
});

test("each row's runners keep to one line, cut where the row has no room for them all", async ({
  page,
}) => {
  // desk's turns run on two runners named as the chart names its pods.
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeBoard(page, { retired: true, crowded: true });
  const view = page.getByRole("region", { name: "Board content" });
  const row = (name: string) =>
    view.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
  const handle = page.getByRole("button", { name: /^Width of the board's content/ });
  for (const island of [420, 490]) {
    await page.addInitScript((width) => {
      localStorage.setItem("stellaris.contentWidth", String(width));
    }, island);
    await page.goto("/citizens?window=all");
    await expect(handle).toHaveAccessibleName(
      new RegExp(`^Width of the board's content, ${island} of`),
    );
    const runners = row("desk").getByTitle(/^outside projects: stellaris-runner-0; lab:/);
    await expect(runners).toHaveText("on stellaris-runner-0, stellaris-runner-1");
    expect(await lineCountOf(runners), `lines at ${island} px`).toBe(1);
    expect(await cutOf(runners), `cut at ${island} px`).toBeGreaterThan(0);
    await expect(runners).toHaveCSS("text-overflow", "ellipsis");
    // The runners keep as much room as the model beside them, and every row is as tall as the
    // others: one line, and the counts' line under it.
    const model = row("desk").getByTitle("claude-opus-5-5 · set to opus · xhigh");
    const [runnersBox, modelBox] = await Promise.all([boxOf(runners), boxOf(model)]);
    expect(runnersBox.width).toBeGreaterThanOrEqual(modelBox.width - 1);
    const heights = await view
      .getByRole("listitem")
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    expect(heights).toHaveLength(4);
    expect(Math.max(...heights) - Math.min(...heights), `rows at ${island} px`).toBeLessThan(1);
    // Screen readers still hear every runner.
    await expect(row("desk").getByRole("link")).toHaveAccessibleName(
      /on stellaris-runner-0, stellaris-runner-1/,
    );
    expect(await sidewaysOf(view)).toBe(0);
  }
});

test("the counts move beside the state at a 576 px island, to the pixel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("stellaris.contentWidth", "575"));
  await fakeBoard(page);
  await page.goto("/citizens");
  const view = page.getByRole("region", { name: "Board content" });
  const desk = view.getByRole("listitem").filter({ has: page.getByText("desk", { exact: true }) });
  const handle = page.getByRole("button", { name: /^Width of the board's content/ });
  const separator = desk.getByText("·", { exact: true });
  await expect(handle).toHaveAccessibleName(/^Width of the board's content, 575 of/);
  await expect(desk).toContainText("151K in · 1.5K out");
  await expect(separator).toBeHidden();

  await page.addInitScript(() => localStorage.setItem("stellaris.contentWidth", "576"));
  await page.reload();
  await expect(handle).toHaveAccessibleName(/^Width of the board's content, 576 of/);
  await expect(separator).toBeVisible();
});
