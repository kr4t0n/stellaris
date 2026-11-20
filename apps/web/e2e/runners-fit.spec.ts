import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

// Headless Chromium starts with --hide-scrollbars, under which the view's scrollbar would take no
// room, and a container query counts the room it takes.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/** The narrowest island in which, at each root font, a row keeps to one line: 25 root ems of list. */
const ONE_LINE: Record<number, number> = { 16: 420, 20: 520, 24: 624 };

for (const root of [16, 20, 24]) {
  for (const layout of ["around", "beside"] as const) {
    test(`at a ${root} px root font no island width scrolls the runners list sideways, and every name, state, and control stays in view, with the longest state (${layout} the sky)`, async ({
      page,
    }) => {
      // 20 px is Chrome's Font size "Large", and 24 px its "Very large": the app sets no root
      // size, so the browser's scales every rem.
      await page.addInitScript(
        ({ size, chosen }) => {
          document.addEventListener("DOMContentLoaded", () => {
            document.documentElement.style.fontSize = `${size}px`;
          });
          localStorage.setItem("stellaris.boardLayout", chosen);
        },
        { size: root, chosen: layout },
      );
      await page.setViewportSize({ width: 1050, height: 1400 });
      // pod's Claude is held by its limit; with its Codex paused and its board syncing, its state
      // is as long as a state gets, two CLIs' worth and the sync.
      const board = await fakeBoard(page, { quotas: "limited" });
      board.setSync(
        {
          phase: "copying",
          files: 6_200,
          totalFiles: 15_152,
          bytes: 11_000_000,
          totalBytes: 27_000_000,
          attempt: 1,
          startedAt: new Date(Date.now() - 90_000).toISOString(),
          updatedAt: new Date(Date.now() - 1_000).toISOString(),
        },
        "pod",
      );
      await page.goto("/runners");
      const list = page.getByRole("list", { name: "Registered" });
      await expect(list.getByRole("listitem")).toHaveCount(3);
      await list.getByRole("button", { name: "Pause codex on pod" }).click();
      await expect(list.getByTitle(/^connected; codex paused /)).toHaveText(
        "codex paused · claude held · syncing",
      );
      const handle = page.getByRole("button", { name: /^Width of the board's content/ });
      for (const state of ["marks", "remove"] as const) {
        if (state === "remove") {
          // pod's is the widest row, with two CLIs and the red Remove 6 px wider than the marks.
          await list.getByRole("button", { name: "Remove pod…" }).click();
          await expect(list.getByRole("button", { name: "Remove pod", exact: true })).toBeFocused();
        }
        // The narrowest island and the widest default, the edges of the bands where dev's rows ran
        // past the island, and of the two lines a row takes under 25 root ems. A window tall
        // enough for the whole view, and one short enough that it scrolls, with its scrollbar.
        for (const [island, height] of [
          420, 425, 426, 440, 460, 503, 519, 520, 556, 572, 623, 624, 680,
        ].flatMap((width) => [1400, 500].map((tall) => [width, tall] as const))) {
          // The default content is two fifths of the window.
          await page.setViewportSize({ width: Math.round(island * 2.5), height });
          await expect(handle).toHaveAccessibleName(
            new RegExp(`^Width of the board's content, ${island} of`),
          );
          const fit = await list.evaluate((ul) => {
            const scroller = ul.closest(".overflow-y-auto");
            const outer = (scroller ?? ul).getBoundingClientRect();
            // The room inside the scroller's border, short of its scrollbar.
            const bounds = {
              left: outer.left + (scroller?.clientLeft ?? 0),
              right:
                outer.left + (scroller?.clientLeft ?? 0) + (scroller?.clientWidth ?? outer.width),
            };
            const rows = [...ul.children];
            // Each row's cells, the OS, the version, the capabilities, and the projects out of their box.
            const cells = rows.map((row) => [
              ...row.querySelectorAll(":scope > :not(.contents), :scope > .contents > *"),
            ]);
            // Each runner's name, its state, and every button in its row: the CLIs' marks, the
            // pause, the pencil, the bin, and the red Remove.
            const reached = rows.flatMap((row, at) => [
              ...[...row.querySelectorAll("button")].map(
                (button) => [button.getAttribute("aria-label") ?? "", button] as const,
              ),
              ...[...row.children[1]!.querySelectorAll(":scope > span:first-child")].map(
                (name) => [`name ${name.textContent}`, name] as const,
              ),
              [`state ${cells[at]![6]?.textContent}`, cells[at]![6]!] as const,
            ]);
            return {
              root: getComputedStyle(document.documentElement).fontSize,
              sideways:
                scroller === null ? Number.NaN : scroller.scrollWidth - scroller.clientWidth,
              scrollbar:
                scroller instanceof HTMLElement
                  ? scroller.offsetWidth - scroller.clientWidth
                  : Number.NaN,
              outside: reached
                .filter(([, element]) => {
                  const box = element.getBoundingClientRect();
                  return box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5;
                })
                .map(([label]) => label),
              reached: reached.length,
              // The states cut short: only one of several parts may be.
              cut: cells
                .map((row) => row[6])
                .filter((cell) => cell !== undefined && cell.scrollWidth > cell.clientWidth)
                .map((cell) => cell!.textContent),
              // Whether the OS sits on the line of the runner's state, or a line of its own.
              oneLine: cells.map((row) => {
                const [os, said] = [row[2], row[6]].map((cell) => {
                  const box = cell?.getBoundingClientRect();
                  return box === undefined ? Number.NaN : box.top + box.height / 2;
                });
                return Math.abs((os ?? Number.NaN) - (said ?? Number.NaN)) < 1;
              }),
            };
          });
          const at = `${state} in a ${island} px island, ${height} px tall`;
          expect(fit.root).toBe(`${root}px`);
          expect(fit.scrollbar > 0, at).toBe(height === 500);
          expect(fit.sideways, at).toBe(0);
          expect(fit.outside, at).toEqual([]);
          // Three names and states, four CLIs' marks, and each row's pause, pencil, and bin, or
          // on pod's row the red Remove in their place.
          expect(fit.reached).toBe(state === "marks" ? 6 + 4 + 9 : 6 + 4 + 6 + 1);
          // studio's `connected` and laptop's `away` stay whole; pod's long state alone is cut.
          expect(fit.cut, at).toEqual(
            fit.cut.filter((said) => said === "codex paused · claude held · syncing"),
          );
          expect(fit.oneLine, at).toEqual(fit.oneLine.map(() => island >= ONE_LINE[root]!));
        }
      }
    });
  }
}
