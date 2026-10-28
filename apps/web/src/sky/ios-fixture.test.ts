import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.js";
import { frameSphere, homeCamera } from "./camera.js";
import { band, tableText, type InsetViewport } from "./ios-tables.js";
import { markLabel, skyModel, type SkyModel } from "./model.js";
import { FOCUS_ROOM } from "./scene.js";

/**
 * The browser tests' fake board, which `tsconfig.e2e.json` checks. A path held in a constant keeps
 * this project's compiler out of that one's files, and Vitest runs the module as it is.
 */
const FAKE_BOARD = "../../e2e/board.ts";

interface FakeRequest {
  url(): string;
  method(): string;
  postDataJSON(): unknown;
}

interface FakeRoute {
  request(): FakeRequest;
  fulfill(answer: { readonly status?: number; readonly body: string }): Promise<void>;
}

type Handler = (route: FakeRoute) => Promise<void>;

/** The parts of a Playwright page the fake board uses. */
interface FakePage {
  addInitScript(script: unknown, arg?: unknown): Promise<void>;
  route(pattern: string, handler: Handler): Promise<void>;
}

interface FakeBoardModule {
  readonly TOKEN: string;
  fakeBoard(
    page: FakePage,
    options: Record<string, boolean>,
  ): Promise<{ setWorking(running: number, queued?: number): void }>;
}

function isFakeBoardModule(value: unknown): value is FakeBoardModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "fakeBoard" in value &&
    typeof value.fakeBoard === "function" &&
    "TOKEN" in value &&
    typeof value.TOKEN === "string"
  );
}

/** A board the fake board serves: its options, and what the user does on it first. */
interface Board {
  readonly name: string;
  readonly options: Record<string, boolean>;
  readonly first?: (
    board: { setWorking(running: number, queued?: number): void },
    send: (path: string, body: Record<string, unknown>) => Promise<void>,
  ) => Promise<void> | void;
}

const BOARDS: readonly Board[] = [
  { name: "the fake board", options: {} },
  {
    name: "crowded, with a citizen retired, a project archived, and a turn in flight",
    options: { crowded: true, retired: true, archived: true, inFlight: true },
  },
  { name: "a check named for the user before the sign-off", options: { earlyApproval: true } },
  {
    name: "the study landing once the user signs off",
    options: {},
    first: (_board, send) =>
      send("/api/verbs/advance_task", { task_id: "01M3Q2AAAAAAAAAAAAAAAAAAA1" }),
  },
  {
    name: "turns at lab for names the board doesn't list",
    options: {},
    first: (board) => board.setWorking(3, 2),
  },
];

/** The sky's frame in the app's poses, with what covers it as insets. */
const POSES: ReadonlyArray<{ readonly name: string; readonly view: InsetViewport }> = [
  {
    name: "a narrow display with a bar on its trailing side",
    view: { width: 466, height: 678, left: 0, right: 52, top: 0, bottom: 0 },
  },
  {
    name: "the same display on its side",
    view: { width: 678, height: 466, left: 0, right: 52, top: 0, bottom: 0 },
  },
  {
    name: "the leading part of a wide display, under a camera",
    view: { width: 519, height: 669, left: 0, right: 0, top: 32, bottom: 0 },
  },
  {
    name: "above a fold across the display",
    view: { width: 669, height: 951, left: 0, right: 0, top: 24, bottom: 526 },
  },
  {
    name: "the narrowest Split View",
    view: { width: 320, height: 678, left: 52, right: 0, top: 0, bottom: 0 },
  },
];

/**
 * The board as the web's sky reads it: through the web's own API client, with every request
 * answered by the fake board, and each answer kept as it was sent for BoardKit to read.
 */
async function read(module: FakeBoardModule, each: Board) {
  const handlers: Handler[] = [];
  const page: FakePage = {
    addInitScript: async () => {},
    route: async (pattern, handler) => {
      if (pattern === "**/api/**") {
        handlers.push(handler);
      }
    },
  };
  const board = await module.fakeBoard(page, each.options);
  const ask = async (method: string, path: string, body: unknown = null) => {
    const handler = handlers[0];
    if (handler === undefined) {
      throw new Error("the fake board answers nothing under /api");
    }
    let answer = { status: 0, body: "" };
    await handler({
      request: () => ({
        url: () => `http://127.0.0.1${path}`,
        method: () => method,
        postDataJSON: () => body,
      }),
      fulfill: async ({ status = 200, body: text }) => {
        answer = { status, body: text };
      },
    });
    return answer;
  };
  await each.first?.(board, async (path, body) => {
    await ask("POST", path, body);
  });
  const answers = new Map<string, unknown>();
  vi.stubGlobal("fetch", async (path: string) => {
    const { status, body } = await ask("GET", path);
    answers.set(path, JSON.parse(body));
    return new Response(body, { status });
  });
  const api = createApi(module.TOKEN);
  const [members, projects, scheduler] = await Promise.all([
    api.members(),
    api.projects(),
    api.scheduler(),
  ]);
  const tasks = (await Promise.all(projects.map((project) => api.tasks(project.slug)))).flat();
  return {
    snapshot: { members, projects, scheduler, tasks },
    answers: {
      members: answers.get("/api/members"),
      projects: answers.get("/api/projects"),
      scheduler: answers.get("/api/scheduler"),
      // Every project's tasks in one list, as the sky takes them.
      tasks: projects.flatMap((project) => {
        const list = answers.get(`/api/projects/${project.slug}/tasks`);
        return Array.isArray(list) ? list : [];
      }),
    },
  };
}

describe("the sky's fixture for BoardKit's port", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes what the sky and its camera make of the fake board to apps/ios/fixtures/sky", async () => {
    const module: unknown = await import(/* @vite-ignore */ FAKE_BOARD);
    if (!isFakeBoardModule(module)) {
      throw new Error(`${FAKE_BOARD} no longer exports fakeBoard and TOKEN`);
    }
    const fixture: Array<{
      name: string;
      answers: unknown;
      model: SkyModel;
      labels: string[];
      cameras: unknown[];
    }> = [];
    for (const each of BOARDS) {
      const { snapshot, answers } = await read(module, each);
      const model = skyModel(snapshot);
      const place = (id: string): string =>
        model.anchors.find((anchor) => anchor.id === id)?.label ?? id;
      fixture.push({
        name: each.name,
        answers,
        model,
        labels: model.tasks.map((mark) => markLabel(mark, place(mark.project))),
        cameras: POSES.map(({ name, view }) => {
          const home = homeCamera(band(view), model.radius);
          return {
            pose: name,
            view,
            home,
            // Each project brought into view from the home view, as the scene frames a focus.
            frames: model.anchors
              .filter((anchor) => anchor.kind === "project")
              .map((anchor) => ({
                anchor: anchor.id,
                camera: frameSphere(home, band(view), {
                  x: anchor.x,
                  y: anchor.y,
                  reach: anchor.radius + FOCUS_ROOM,
                }),
              })),
          };
        }),
      });
    }
    // Each board serves something of its own, and turns for names it doesn't list draw nothing.
    expect(new Set(fixture.map((each) => JSON.stringify(each.answers))).size).toBe(BOARDS.length);
    const drawn = (name: string) => fixture.find((each) => each.name === name)?.model;
    expect(drawn("turns at lab for names the board doesn't list")).toEqual(drawn("the fake board"));
    await expect(tableText(fixture)).toMatchFileSnapshot(
      "../../../ios/fixtures/sky/fake-board.json",
    );
  });
});
