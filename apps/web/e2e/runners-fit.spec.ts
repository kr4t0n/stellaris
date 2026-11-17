import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

// Headless Chromium starts with --hide-scrollbars, under which the view's scrollbar would take no
// room, and a container query counts the room it takes.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

for (const root of [16, 20]) {
  for (const layout of ["around", "beside"] as const) {
    test(`at a ${root} px root font no island width scrolls the runners list sideways, and every name and control stays in view (${layout} the sky)`, async ({
      page,
    }) => {
      // 20 px is Chrome's Font size "Large": the app sets no root size, so the browser's scales
      // every rem.
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
      await fakeBoard(page);
      await page.goto("/runners");
      const list = page.getByRole("list", { name: "Registered" });
      await expect(list.getByRole("listitem")).toHaveCount(3);
      const handle = page.getByRole("button", { name: /^Width of the board's content/ });
      for (const state of ["marks", "remove"] as const) {
        if (state === "remove") {
          // pod's is the widest row, with two CLIs and the red Remove 6 px wider than the marks.
          await list.getByRole("button", { name: "Remove pod…" }).click();
          await expect(list.getByRole("button", { name: "Remove pod", exact: true })).toBeFocused();
        }
        // The narrowest island and the widest default, and at a 20 px root the edges of the
        // bands where one line didn't fit, under 503 px with the marks and 519 with the red
        // Remove: a row takes two lines under 520, where the list holds less than 25 root ems.
        // A window tall enough for the whole view, and at a 20 px root one short enough that it
        // scrolls, with its scrollbar. At a 16 px root that scrollbar beside the red Remove scrolls
        // a 420 to 425 px island 1 to 6 px sideways, as the row always has.
        const heights = root === 16 ? [1400] : [1400, 500];
        for (const [island, height] of [420, 421, 460, 502, 503, 518, 519, 520, 521, 680].flatMap(
          (width) => heights.map((tall) => [width, tall] as const),
        )) {
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
            // Each runner's name and every button in its row: the CLIs' marks, the pause, the
            // pencil, the bin, and the red Remove.
            const reached = rows.flatMap((row) => [
              ...[...row.querySelectorAll("button")].map(
                (button) => [button.getAttribute("aria-label") ?? "", button] as const,
              ),
              ...[...row.children[1]!.querySelectorAll(":scope > span:first-child")].map(
                (name) => [`name ${name.textContent}`, name] as const,
              ),
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
                  return box.left < bounds.left || box.right > bounds.right;
                })
                .map(([label]) => label),
              reached: reached.length,
              // Whether the OS sits on the line of the runner's state, or a line of its own.
              oneLine: rows.map((row) => {
                const [os, said] = [row.children[2], row.children[6]].map((cell) => {
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
          // Three names, four CLIs' marks, and each row's pause, pencil, and bin, or on pod's row
          // the red Remove in their place.
          expect(fit.reached).toBe(state === "marks" ? 3 + 4 + 9 : 3 + 4 + 6 + 1);
          expect(fit.oneLine, at).toEqual(fit.oneLine.map(() => root === 16 || island >= 520));
        }
      }
    });
  }
}
