import { expect, test, type Locator, type Page } from "@playwright/test";
import { fakeBoard } from "./board.js";

const CHANNEL = "lab/general";
const THREAD = "01M3Q2PPPPPPPPPPPPPPPPPPP1";
const OPENED = Date.parse("2026-09-29T09:00:00.000Z");

function postId(n: number): string {
  return `01M3Q2NNNNNNNNNNNNNNNNN${String(n).padStart(3, "0")}`;
}

function at(minutes: number): string {
  return new Date(OPENED + minutes * 60_000).toISOString();
}

/** A report long enough to be folded, and taller than the list at any window size here. */
const REPORT = Array.from(
  { length: 30 },
  (_, index) =>
    `Paragraph ${index + 1} of the report, with enough words to wrap across the island at any width it takes.`,
).join("\n\n");

/** Post `n` of 40, two minutes apart, in the channel or in the thread; `long` ones are reports. */
function post(n: number, thread: boolean, long: readonly number[]) {
  return {
    id: postId(n),
    author: n % 2 === 0 ? "ada" : "desk",
    channel: CHANNEL,
    ...(thread ? { thread: THREAD } : {}),
    ts: at(n * 2),
    mentions: [],
    body: long.includes(n)
      ? `Post ${n}: the full report.\n\n${REPORT}`
      : `Post ${n}: the survey's next step.\n\nA second paragraph, so each post takes a few lines.`,
  };
}

/**
 * The channel's 40 posts, with a thread opened after every tenth, so thread lines run all the way
 * down the stream, as they do on a board in use; and a thread of 40 posts of its own.
 */
async function serve(page: Page, long: readonly number[] = []) {
  await fakeBoard(page);
  const posts = (thread: boolean) =>
    Array.from({ length: 40 }, (_, index) => post(index + 1, thread, long));
  const threads = [10, 20, 30, 38].map((n, index) => ({
    id: `01M3Q2PPPPPPPPPPPPPPPPPPQ${index + 1}`,
    channel: CHANNEL,
    title: `Opened after post ${n}`,
    state: "open",
    openedBy: "ada",
    openedAt: at(n * 2 + 1),
    body: "",
    messages: 1,
    lastMessageId: null,
    lastAuthor: "ada",
  }));
  await page.route("**/api/threads", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(threads) }),
  );
  await page.route(`**/api/channels/${CHANNEL}`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(posts(false)) }),
  );
  await page.route(`**/api/threads/${THREAD}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        thread: {
          id: THREAD,
          channel: CHANNEL,
          title: "A long thread",
          state: "open",
          openedBy: "ada",
          openedAt: at(0),
          body: "",
        },
        messages: posts(true),
      }),
    }),
  );
}

function island(page: Page): Locator {
  return page.getByRole("region", { name: "Board content" });
}

/** The scrolling list of the view's posts. */
function listOf(page: Page): Locator {
  return island(page).locator("article").first().locator("xpath=..");
}

const marked = (page: Page) => page.locator('article[aria-current="true"]');

/**
 * Where the content island's header, list, and reply box are, and how far the island itself is
 * scrolled, once two frames have been drawn.
 */
async function panel(page: Page) {
  return island(page).evaluate(async (element) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = (selector: string) => {
      const found = element.querySelector(`:scope > ${selector}`);
      if (found === null) {
        throw new Error(`no ${selector} in the island`);
      }
      const { x, y, width, height } = found.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      scroll: { top: element.scrollTop, left: element.scrollLeft },
      header: box("header"),
      list: box("div:has(article)"),
      reply: box("form"),
    };
  });
}

/** The marked post's box, and the visible box of the list it is in. */
async function placed(page: Page) {
  const list = await listOf(page).boundingBox();
  const target = await marked(page).boundingBox();
  if (list === null || target === null) {
    throw new Error("the list or the marked post is not on the page");
  }
  return { list, target };
}

for (const [width, height] of [
  [1600, 1000],
  [800, 600],
] as const) {
  test(`a link to a post at a channel's end scrolls only its list, at ${width}×${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await serve(page);
    await page.goto(`/c/${CHANNEL}`);
    await expect(page.getByText("Post 40:")).toBeInViewport();
    const plain = await panel(page);
    expect(plain.scroll).toEqual({ top: 0, left: 0 });

    for (const n of [40, 39]) {
      await page.goto("about:blank");
      await page.goto(`/c/${CHANNEL}?message=${postId(n)}`);
      await expect(marked(page)).toContainText(`Post ${n}:`);
      // The panel is as the channel opens without a link: nothing above the list moved.
      expect(await panel(page)).toEqual(plain);
      const { list, target } = await placed(page);
      expect(target.y).toBeGreaterThanOrEqual(list.y);
      expect(target.y + target.height).toBeLessThanOrEqual(list.y + list.height);
    }
  });
}
