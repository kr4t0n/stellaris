import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { z } from "zod";
// The server's own build, by path: the exit test needs the board server, never the interface.
import {
  startSocietyServer,
  type SocietyServer,
} from "../../server/dist/testing/society-server.js";

// Phase 7's exit test: a browser session against a whole board server on a fresh society, where
// scripted citizens stand in for the CLIs and every turn stops at a checkpoint until released, so
// the sky can be checked while each turn is running. The sky is read through its copy for
// keyboards and screen readers, which is drawn from the same model as the canvas. Each test starts
// a society of its own on a free port, so copies of it never share one.

const STEP = 20_000;
const MARK = "Task Add hello.txt at Demo";

test.setTimeout(150_000);

let society: SocietyServer;

test.beforeEach(async () => {
  society = await startSocietyServer({
    port: 0,
    webDir: path.resolve(import.meta.dirname, "../dist"),
  });
});

test.afterEach(async () => {
  await society.stop();
});

/** Lets the citizen's held turn go on, once it has reached its checkpoint. */
async function release(request: APIRequestContext, agent: string): Promise<void> {
  await expect
    .poll(
      async () => (await request.post(`${society.url}/test/release`, { data: { agent } })).status(),
      { message: `${agent}'s turn reaches its checkpoint`, timeout: STEP },
    )
    .toBe(200);
}

function sky(page: Page) {
  const citizens = page.getByRole("list", { name: "Citizens", exact: true });
  return {
    star: (name: string) => citizens.getByRole("button", { name: new RegExp(`^${name}, `) }),
    marks: page.getByRole("list", { name: "Tasks in play" }),
  };
}

test("an ask becomes a planned task that citizens carry to done, and the sky follows every step", async ({
  page,
  request,
}) => {
  const { token } = z
    .object({ token: z.string() })
    .parse(await (await request.post(`${society.url}/test/token`)).json());
  await page.goto(society.url);
  await page.getByLabel("Board token").fill(token);
  await page.getByRole("button", { name: "Enter the playground" }).click();

  // The society at rest: everyone at the core, nothing in play.
  const { star, marks } = sky(page);
  for (const name of ["desk", "eng-1", "rev-1"]) {
    await expect(star(name)).toHaveAccessibleName(`${name}, idle`);
  }
  await expect(marks.getByRole("listitem")).toHaveCount(0);
  const mark = marks.getByRole("button", { name: new RegExp(`^${MARK}`) });

  // The user asks, naming no project and no citizen; the front desk takes it in a turn of its own.
  await page.keyboard.press("Space");
  const box = page.getByRole("region", { name: "Ask", exact: true });
  const field = box.getByRole("textbox", { name: "Ask the front desk" });
  await field.fill("Please add hello.txt to demo with a greeting, and have it reviewed.");
  await field.press("Enter");
  const ask = box.getByRole("listitem").first();
  await expect(star("desk")).toHaveAccessibleName("desk, working at the society", {
    timeout: STEP,
  });
  await expect(ask).toContainText("desk is answering…");
  await release(request, "desk");

  // The desk plans a build and a gated review and answers where it was asked.
  await expect(ask).toContainText("answered by desk", { timeout: STEP });
  await field.press("Escape");
  await expect(box).toBeHidden();
  await expect(page.getByRole("button", { name: /to ask$/ })).toHaveAccessibleName(
    /^desk answered “Please add hello\.txt/,
  );

  // The build stage wakes the engineer, whose star goes to the project, linked to the task.
  await expect(mark).toHaveAccessibleName(
    `${MARK}, stage build, being worked, held by eng-1, in a turn there`,
    { timeout: STEP },
  );
  await expect(star("eng-1")).toHaveAccessibleName("eng-1, working at Demo");
  await expect(star("desk")).toHaveAccessibleName("desk, idle");
  await release(request, "eng-1");

  // The gated review: the reviewer takes it and sends the work back once.
  await expect(mark).toHaveAccessibleName(
    `${MARK}, stage review, being worked, held by rev-1, in a turn there`,
    { timeout: STEP },
  );
  await expect(star("rev-1")).toHaveAccessibleName("rev-1, working at Demo");
  await expect(star("eng-1")).toHaveAccessibleName("eng-1, idle");
  await release(request, "rev-1");

  // The send-back wakes the stage's last holder, and the mark says the work came back.
  await expect(mark).toHaveAccessibleName(
    `${MARK}, stage build, sent back, held by eng-1, in a turn there`,
    { timeout: STEP },
  );
  await expect(star("rev-1")).toHaveAccessibleName("rev-1, idle");
  await release(request, "eng-1");

  // The reworked build passes the review, the board lands the branch, and the task leaves the sky.
  await expect(mark).toHaveAccessibleName(
    `${MARK}, stage review, being worked, held by rev-1, in a turn there`,
    { timeout: STEP },
  );
  await release(request, "rev-1");
  await expect(marks.getByRole("listitem")).toHaveCount(0, { timeout: STEP });
  for (const name of ["desk", "eng-1", "rev-1"]) {
    await expect(star(name)).toHaveAccessibleName(`${name}, idle`, { timeout: STEP });
  }

  // From the ask to the task: its thread records every handover, the send-back, and the landing.
  await page.keyboard.press("Space");
  await box.getByRole("link", { name: /Please add hello\.txt/ }).click();
  const content = page.getByRole("region", { name: "Board content" });
  await expect(content).toContainText("eng-1 builds it and rev-1 reviews it.");
  await content.getByRole("link", { name: "Add hello.txt" }).click();
  await expect(page).toHaveURL(/\/task\/[0-9A-HJKMNP-TV-Z]{26}$/);
  for (const step of ["finished build → review", "sent back from review to build", "landed"]) {
    await expect(content).toContainText(step, { timeout: STEP });
  }
  await expect(content).toContainText(/merged into main at [0-9a-f]+/);
  await expect(page.getByRole("button", { name: /to ask$/ })).toHaveAccessibleName("Space to ask");

  // The desk, which filed the task, was told it is done and told the user.
  await page.goto(`${society.url}/c/general`);
  await expect(content).toContainText("What you asked for is in: its task is done.", {
    timeout: STEP,
  });
});
