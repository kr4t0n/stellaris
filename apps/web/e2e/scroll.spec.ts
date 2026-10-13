import { expect, test, type Locator, type Page } from "@playwright/test";
import { ARCHIVE_PROPOSAL, fakeBoard, SKILL_PROPOSAL, STAGE_TASK } from "./board.js";

const THREAD = "01M3Q2MMMMMMMMMMMMMMMMMMM1";
const OPENED = "2026-09-29T09:00:00.000Z";

function messageId(n: number): string {
  return `01M3Q2MMMMMMMMMMMMMMMMM${String(n).padStart(3, "0")}`;
}

/** A thread's record: a topic thread, unless it is a task's or a proposal's. */
interface Place {
  readonly id: string;
  readonly channel: string;
  readonly subject?: { kind: "task" | "proposal"; id: string };
}

const TOPIC: Place = { id: THREAD, channel: "lab/general" };

function message(n: number, place: Place = TOPIC) {
  return {
    id: messageId(n),
    author: n % 2 === 0 ? "ada" : "desk",
    channel: place.channel,
    thread: place.id,
    ts: OPENED,
    mentions: [],
    body: `Message ${n}: the survey's next step.\n\nA second paragraph, so each message takes a few lines.`,
  };
}

/**
 * A thread of `count` messages, and a way to post more: each new message is answered on the next
 * read of the thread, which an event on the board's stream asks for.
 */
async function longThread(page: Page, count: number, place: Place = TOPIC) {
  const messages = Array.from({ length: count }, (_, index) => message(index + 1, place));
  // Reads of the thread wait while a test holds them.
  let held = Promise.resolve();
  await fakeBoard(page);
  await page.route(`**/api/threads/${place.id}`, async (route) => {
    await held;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        thread: {
          id: place.id,
          channel: place.channel,
          ...(place.subject === undefined ? {} : { subject: place.subject }),
          title: "A long thread",
          state: "open",
          openedBy: "ada",
          openedAt: OPENED,
          body: "",
        },
        messages,
      }),
    });
  });
  // The stream stays quiet until a test posts; then it carries that one event and ends, and the
  // interface reconnects to wait for the next.
  let post = Promise.withResolvers<string>();
  await page.route("**/api/events/stream**", async (route) => {
    const id = await post.promise;
    post = Promise.withResolvers<string>();
    const event = {
      id,
      ts: OPENED,
      type: "message.posted",
      actor: "ada",
      payload: { channel: place.channel, thread: place.id, id },
    };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`,
    });
  });
  return {
    /** Holds reads of the thread until the function returned is called. */
    hold(): () => void {
      const { promise, resolve } = Promise.withResolvers<void>();
      held = promise;
      return resolve;
    },
    /** Adds `more` messages to the thread and tells the interface. */
    postMore(more: number): void {
      for (let index = 0; index < more; index += 1) {
        messages.push(message(messages.length + 1, place));
      }
      post.resolve(messageId(messages.length));
    },
  };
}

/** The record of a thread at `place`, as the board lists it. */
function threadRecord(place: Place) {
  return {
    id: place.id,
    channel: place.channel,
    ...(place.subject === undefined ? {} : { subject: place.subject }),
    title: "A long thread",
    state: "open",
    openedBy: "ada",
    openedAt: OPENED,
    body: "",
  };
}

/**
 * Serves a thread of 40 messages at `place`, numbered from `from` so that one thread's ids all come
 * after another's, the first of them naming `link`, which the board shows as a link to it.
 */
async function serveThread(page: Page, place: Place, from: number, link: string) {
  const messages = Array.from({ length: 40 }, (_, index) => message(from + index, place));
  messages[0] = { ...message(from, place), body: `Message ${from}: see ${link}.` };
  await page.route(`**/api/threads/${place.id}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ thread: threadRecord(place), messages }),
    }),
  );
}

/** A task of one stage, blocked by `blocker`. */
function fakeTask(id: string, blocker: string, title: string) {
  return {
    id,
    project: "lab",
    title,
    status: "open",
    createdBy: "desk",
    createdAt: OPENED,
    updatedAt: OPENED,
    blockedBy: [blocker],
    requiredCapabilities: [],
    stages: [{ id: "s1", name: "Work", gate: false, holders: [] }],
    stage: "s1",
    stageSince: OPENED,
    stageSeq: 1,
    onDone: "none",
    completing: false,
    body: "",
  };
}

/** A task's or a proposal's view, opened at its top, with nothing counted as new. */
async function opensAfresh(page: Page, newest: string): Promise<void> {
  await expect(page.getByText(newest)).toBeAttached();
  await expect(jumpButton(page)).toHaveAccessibleName("Jump to latest");
  const list = page
    .locator("article")
    .first()
    .locator("xpath=ancestor::div[contains(@class, 'overflow-y-auto')][1]");
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
}

/** The thread's scrolling list: the parent of its messages. */
function listOf(page: Page): Locator {
  return page
    .getByRole("region", { name: "Board content" })
    .locator("article")
    .first()
    .locator("xpath=..");
}

function distanceToEnd(list: Locator): Promise<number> {
  return list.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

/** Scrolls the list to `distance` pixels from its end, and waits until the list has drawn it. */
async function scrollToDistance(list: Locator, distance: number): Promise<void> {
  await list.evaluate(async (element, from) => {
    const scrolled = new Promise((resolve) => {
      element.addEventListener("scroll", resolve, { once: true });
    });
    element.scrollTop = element.scrollHeight - element.clientHeight - from;
    await scrolled;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, distance);
}

function jumpButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Jump to latest/ });
}

test("a long thread shows a jump to its newest message only away from the end, and a click lands there and keeps new messages in view", async ({
  page,
}) => {
  const thread = await longThread(page, 60);
  await page.goto(`/thread/${THREAD}`);
  const list = listOf(page);
  await expect(page.getByText("Message 60:")).toBeInViewport();
  expect(await distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(jumpButton(page)).toHaveCount(0);

  // Within 80 pixels of the end the reader is still there; past it, the button shows.
  await scrollToDistance(list, 79);
  await expect(jumpButton(page)).toHaveCount(0);
  await scrollToDistance(list, 81);
  await expect(jumpButton(page)).toBeVisible();
  await scrollToDistance(list, 40);
  await expect(jumpButton(page)).toHaveCount(0);
  await scrollToDistance(list, 81);
  await expect(jumpButton(page)).toBeVisible();

  // Scrolling up with the wheel, as a reader does.
  await list.hover();
  await page.mouse.wheel(0, -3_000);
  await expect.poll(() => distanceToEnd(list)).toBeGreaterThan(2_000);
  await expect(jumpButton(page)).toHaveAccessibleName("Jump to latest");

  // Messages that arrive while the reader is up leave them where they are, and the button counts them.
  const before = await list.evaluate((element) => element.scrollTop);
  thread.postMore(2);
  await expect(page.getByText("Message 62:")).toBeAttached();
  await expect(jumpButton(page)).toHaveAccessibleName("Jump to latest, 2 new");
  await expect(jumpButton(page)).toContainText("2");
  expect(await list.evaluate((element) => element.scrollTop)).toBe(before);

  await jumpButton(page).click();
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(page.getByText("Message 62:")).toBeInViewport();
  await expect(jumpButton(page)).toHaveCount(0);

  // Pinned again: the next messages keep the list at its end.
  thread.postMore(3);
  await expect(page.getByText("Message 65:")).toBeInViewport();
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(jumpButton(page)).toHaveCount(0);
});

test("messages that arrive during the jump move its end, and it lands at the newest", async ({
  page,
}) => {
  const thread = await longThread(page, 60);
  await page.goto(`/thread/${THREAD}`);
  const list = listOf(page);
  await expect(page.getByText("Message 60:")).toBeInViewport();
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(jumpButton(page)).toBeVisible();

  // The read the new messages ask for is under way, and is answered as the jump starts.
  const release = thread.hold();
  const read = page.waitForRequest(`**/api/threads/${THREAD}`);
  thread.postMore(5);
  await read;
  await jumpButton(page).click();
  release();
  await expect(page.getByText("Message 65:")).toBeAttached();
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(page.getByText("Message 65:")).toBeInViewport();
  await expect(jumpButton(page)).toHaveCount(0);
});

test("the jump is reached and pressed from the keyboard, and focus lands on the newest message", async ({
  page,
}) => {
  await longThread(page, 60);
  await page.goto(`/thread/${THREAD}`);
  const list = listOf(page);
  await expect(page.getByText("Message 60:")).toBeInViewport();
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  const button = jumpButton(page);
  await expect(button).toBeVisible();

  // The button sits between the list and the reply box in the tab order.
  const reply = page.getByRole("textbox", { name: "Reply in the thread" });
  await reply.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  expect(await button.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  expect(await button.evaluate((element) => getComputedStyle(element).boxShadow)).toContain(
    "0px 0px 0px 2px",
  );

  await page.keyboard.press("Enter");
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(button).toHaveCount(0);
  const newest = page.locator("article").filter({ hasText: "Message 60:" });
  await expect(newest).toBeFocused();
  // On from there, the reply box is next.
  await page.keyboard.press("Tab");
  await expect(reply).toBeFocused();

  // Space presses it too.
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(button).toBeVisible();
  await reply.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  await page.keyboard.press("Space");
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(newest).toBeFocused();
});

test("a link to a message still opens at that message, with the jump showing", async ({ page }) => {
  const thread = await longThread(page, 60);
  await page.goto(`/thread/${THREAD}?message=${messageId(10)}`);
  const list = listOf(page);
  const target = page.locator('article[aria-current="true"]');
  await expect(target).toContainText("Message 10:");
  await expect(target).toBeInViewport();
  await expect(jumpButton(page)).toBeVisible();
  await expect(jumpButton(page)).toHaveAccessibleName("Jump to latest");
  expect(await distanceToEnd(list)).toBeGreaterThan(2_000);

  // The messages after the one linked were there already; only what arrives now is new.
  const linked = await list.evaluate((element) => element.scrollTop);
  thread.postMore(2);
  await expect(page.getByText("Message 62:")).toBeAttached();
  await expect(jumpButton(page)).toHaveAccessibleName("Jump to latest, 2 new");
  expect(await list.evaluate((element) => element.scrollTop)).toBe(linked);

  await jumpButton(page).click();
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(jumpButton(page)).toHaveCount(0);

  // The first message is already in view at the top, so the list does not scroll to it at all.
  await page.goto(`/thread/${THREAD}?message=${messageId(1)}`);
  await expect(target).toContainText("Message 1:");
  await expect(target).toBeInViewport();
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(jumpButton(page)).toBeVisible();
});

/**
 * Jumps from the top of the thread. Returns how far from the end the list was once the click's
 * handlers had run, before any frame was drawn, and the furthest it was at any scroll after.
 */
async function jumpFromTop(page: Page, list: Locator) {
  await scrollToDistance(list, 1e6);
  await expect(jumpButton(page)).toBeVisible();
  await list.evaluate((element) => {
    const distance = () => element.scrollHeight - element.scrollTop - element.clientHeight;
    element.dataset["furthest"] = "0";
    // The interface handles clicks at its root, so a listener on the window runs after it.
    window.addEventListener(
      "click",
      () => {
        element.dataset["atClick"] = String(distance());
      },
      { once: true },
    );
    element.addEventListener("scroll", () => {
      element.dataset["furthest"] = String(
        Math.max(Number(element.dataset["furthest"]), distance()),
      );
    });
  });
  await jumpButton(page).click();
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  return list.evaluate((element) => ({
    atClick: Number(element.dataset["atClick"]),
    furthest: Number(element.dataset["furthest"]),
  }));
}

test("the jump glides over the last screen, and with reduced motion goes straight to the end", async ({
  page,
}) => {
  await longThread(page, 60);
  await page.goto(`/thread/${THREAD}`);
  const list = listOf(page);
  await expect(page.getByText("Message 60:")).toBeInViewport();
  const screen = await list.evaluate((element) => element.clientHeight);

  // Thousands of pixels are skipped at once, and the last screen is left to scroll smoothly.
  const smooth = await jumpFromTop(page, list);
  expect(smooth.atClick).toBeGreaterThan(screen - 2);
  expect(smooth.atClick).toBeLessThan(screen + 2);
  expect(smooth.furthest).toBeLessThanOrEqual(screen + 1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await jumpFromTop(page, list);
  expect(reduced.atClick).toBeLessThanOrEqual(1);
  expect(reduced.furthest).toBeLessThanOrEqual(1);
});

test("a long channel gets the same jump", async ({ page }) => {
  await fakeBoard(page);
  const posts = Array.from({ length: 60 }, (_, index) => ({
    ...message(index + 1),
    thread: undefined,
  }));
  await page.route("**/api/channels/lab/general", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(posts) }),
  );
  await page.goto("/c/lab/general");
  const list = listOf(page);
  await expect(page.getByText("Message 60:")).toBeInViewport();
  await expect(jumpButton(page)).toHaveCount(0);
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await jumpButton(page).click();
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(jumpButton(page)).toHaveCount(0);
});

test("a task's view opens at its plan, and the jump goes to its thread's newest message without following what comes after", async ({
  page,
}) => {
  const thread = await longThread(page, 40, {
    id: STAGE_TASK,
    channel: "lab/general",
    subject: { kind: "task", id: STAGE_TASK },
  });
  await page.goto(`/task/${STAGE_TASK}`);
  await expect(page.getByText("Message 40:")).toBeAttached();
  const list = listOf(page).locator("xpath=ancestor::div[contains(@class, 'overflow-y-auto')][1]");
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.getByRole("heading", { name: "Plan" })).toBeInViewport();
  await expect(jumpButton(page)).toBeVisible();

  // From the keyboard, focus lands on the thread's newest message, not on the section around it.
  await page.getByRole("textbox", { name: "Write in the task's thread" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(jumpButton(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(page.locator("article").filter({ hasText: "Message 40:" })).toBeFocused();
  await expect(page.getByText("Message 40:")).toBeInViewport();
  await expect(jumpButton(page)).toHaveCount(0);

  // The view does not follow: what arrives next waits below, counted.
  thread.postMore(3);
  await expect(page.getByText("Message 43:")).toBeAttached();
  await expect(jumpButton(page)).toHaveAccessibleName("Jump to latest, 3 new");
  expect(await distanceToEnd(list)).toBeGreaterThan(80);
  await jumpButton(page).click();
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(page.getByText("Message 43:")).toBeInViewport();
});

test("a proposal's view gets the same jump to its thread's newest message", async ({ page }) => {
  await longThread(page, 40, {
    id: SKILL_PROPOSAL,
    channel: "governance",
    subject: { kind: "proposal", id: SKILL_PROPOSAL },
  });
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);
  await expect(page.getByText("Message 40:")).toBeAttached();
  const list = listOf(page).locator("xpath=ancestor::div[contains(@class, 'overflow-y-auto')][1]");
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(jumpButton(page)).toBeVisible();
  await jumpButton(page).click();
  await expect.poll(() => distanceToEnd(list)).toBeLessThanOrEqual(1);
  await expect(page.getByText("Message 40:")).toBeInViewport();
  await expect(jumpButton(page)).toHaveCount(0);
});

test("scrolling back up as the jump starts lets go of it, and what arrives next leaves the reader there", async ({
  page,
}) => {
  const thread = await longThread(page, 60);
  await page.goto(`/thread/${THREAD}`);
  const list = listOf(page);
  await expect(page.getByText("Message 60:")).toBeInViewport();
  await scrollToDistance(list, 1e6);
  await expect(jumpButton(page)).toBeVisible();
  // The reader turns back up before the glide has drawn a frame. The interface handles clicks at
  // its root, so a listener on the window runs after the jump has started.
  await list.evaluate((element) => {
    window.addEventListener(
      "click",
      () => {
        element.scrollTop -= 300;
      },
      { once: true },
    );
  });
  await jumpButton(page).click();
  await expect(jumpButton(page)).toBeVisible();
  const settled = await list.evaluate(async (element) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return element.scrollTop;
  });
  expect(await distanceToEnd(list)).toBeGreaterThan(300);

  thread.postMore(3);
  await expect(page.getByText("Message 63:")).toBeAttached();
  await expect(jumpButton(page)).toHaveAccessibleName("Jump to latest, 3 new");
  expect(await list.evaluate((element) => element.scrollTop)).toBe(settled);
});

test("going from one task to another already read starts the count and the place afresh", async ({
  page,
}) => {
  const other = "01M3Q2BBBBBBBBBBBBBBBBBBB1";
  const first: Place = {
    id: STAGE_TASK,
    channel: "lab/general",
    subject: { kind: "task", id: STAGE_TASK },
  };
  const second: Place = { id: other, channel: "lab/general", subject: { kind: "task", id: other } };
  // Each task is blocked by the other, so each view links the other.
  const tasks = [
    fakeTask(STAGE_TASK, other, "The first task"),
    fakeTask(other, STAGE_TASK, "The second task"),
  ];
  await fakeBoard(page);
  await page.route("**/api/projects/lab/tasks", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(tasks) }),
  );
  for (const each of tasks) {
    await page.route(`**/api/tasks/${each.id}`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(each) }),
    );
  }
  await page.route("**/api/threads", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        [first, second].map((place) => ({
          ...threadRecord(place),
          messages: 40,
          lastMessageId: null,
        })),
      ),
    }),
  );
  // The second task's messages all come after the first's.
  await serveThread(page, first, 1, "the board");
  await serveThread(page, second, 101, "the board");
  await page.goto(`/task/${other}`);
  await opensAfresh(page, "Message 140:");
  await page.locator(`a[href="/task/${STAGE_TASK}"]`).first().click();
  await opensAfresh(page, "Message 40:");
  // Read before, so the view goes straight to it without a pane in between.
  await page.locator(`a[href="/task/${other}"]`).first().click();
  await opensAfresh(page, "Message 140:");
  await page.goBack();
  await opensAfresh(page, "Message 40:");
  await page.goForward();
  await opensAfresh(page, "Message 140:");
});

test("going from one proposal to another already read starts the count afresh", async ({
  page,
}) => {
  await fakeBoard(page, { archived: true });
  // Each proposal's thread names the other, and the archive's messages come after the skill's.
  await serveThread(
    page,
    {
      id: SKILL_PROPOSAL,
      channel: "governance",
      subject: { kind: "proposal", id: SKILL_PROPOSAL },
    },
    1,
    ARCHIVE_PROPOSAL,
  );
  await serveThread(
    page,
    {
      id: ARCHIVE_PROPOSAL,
      channel: "governance",
      subject: { kind: "proposal", id: ARCHIVE_PROPOSAL },
    },
    101,
    SKILL_PROPOSAL,
  );
  await page.goto(`/proposal/${ARCHIVE_PROPOSAL}`);
  await opensAfresh(page, "Message 140:");
  await page.locator(`article a[href="/proposal/${SKILL_PROPOSAL}"]`).first().click();
  await opensAfresh(page, "Message 40:");
  await page.locator(`article a[href="/proposal/${ARCHIVE_PROPOSAL}"]`).first().click();
  await opensAfresh(page, "Message 140:");
});
