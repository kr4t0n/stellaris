import type { Member, Task } from "@stellaris/shared";
import { besideCrop, layoutWorld, memorialFrom, plotFrom, squareSpot } from "./layout.js";
import type {
  Citizen,
  CitizenState,
  Crop,
  CropStage,
  House,
  Memorial,
  Plot,
  Point,
  Weather,
  WeatherKind,
  World,
  WorldSnapshot,
} from "./types.js";

export const SOCIETY = "society";
const ACTIVITY_TTL_MS = 20_000;
const FAILED_MERGE_WINDOW_MS = 24 * 3_600_000;
const BUBBLE_CHARS = 80;

function stageOf(task: Task): CropStage {
  switch (task.status) {
    case "open":
      return "seed";
    case "claimed":
      return "growing";
    case "in_review":
      return "ripe";
    case "done":
      return "harvested";
    case "abandoned":
      return "withered";
    case "blocked":
      return "fenced";
    default:
      return "seed";
  }
}

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? "";
  return line.length <= BUBBLE_CHARS ? line : `${line.slice(0, BUBBLE_CHARS)}…`;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Tasks whose last merge failed: a `merge.failed` not followed by a `merge.completed` for the same task. */
function failedMerges(snapshot: WorldSnapshot): Set<string> {
  const failed = new Set<string>();
  for (const event of snapshot.events) {
    const taskId = stringOf(event.payload["taskId"]);
    if (taskId === null) continue;
    if (event.type === "merge.failed") failed.add(taskId);
    if (event.type === "merge.completed") failed.delete(taskId);
  }
  return failed;
}

function parseSignal(key: string): { kind: string; parts: string[] } {
  const [kind = "", ...parts] = key.split(":");
  return { kind, parts };
}

const WEATHER_LABELS: Record<WeatherKind, string> = {
  cloud: "backlog",
  hiring: "role gap",
  dust: "churn",
  cobweb: "stale thread",
  lock: "blocked capability",
  frame: "replica added",
};

/** Where a citizen stands and what it is doing, from the scheduler's queues and the live stream. */
function placeCitizen(
  member: Member,
  snapshot: WorldSnapshot,
  world: {
    plots: ReadonlyMap<string, Plot>;
    layout: ReturnType<typeof layoutWorld>;
    deskIndex: Map<string, number>;
    benchIndex: { value: number };
  },
): { at: Point; state: CitizenState; where: string; lamp: boolean; bubble: string | null } {
  const running = snapshot.scheduler.running.find((pair) => pair.startsWith(`${member.name}/`));
  const pending = snapshot.scheduler.pending.find((pair) => pair.startsWith(`${member.name}/`));
  const resident = snapshot.scheduler.resident.find((pair) => pair.startsWith(`${member.name}/`));
  const activity = snapshot.activity[member.name];
  const fresh = activity !== undefined && snapshot.now - activity.at <= ACTIVITY_TTL_MS;
  const sleeping = snapshot.scheduler.signals.includes(`idle_member:${member.name}`);
  const scopeOf = (pair: string): string => pair.slice(member.name.length + 1);

  const spotIn = (scope: string): Point | null => {
    if (scope === SOCIETY) {
      const index =
        member.role === "concierge" || member.role === "steward" ? 0 : world.benchIndex.value++;
      return squareSpot(world.layout.square, member.role, index);
    }
    const plot = world.plots.get(scope);
    const layout = world.layout.plots.get(scope);
    if (plot === undefined || layout === undefined) return null;
    const own = plot.crops.find((crop) => crop.claimedBy === member.name);
    if (own !== undefined) return besideCrop(own.at);
    const ripe = plot.crops.find((crop) => crop.stage === "ripe");
    if (ripe !== undefined && member.role === "reviewer") return besideCrop(ripe.at);
    const index = world.deskIndex.get(scope) ?? 0;
    world.deskIndex.set(scope, index + 1);
    const desk = layout.desks[index % Math.max(1, layout.desks.length)];
    return desk ?? layout.gate;
  };

  if (running !== undefined) {
    const scope = scopeOf(running);
    const at = spotIn(scope);
    if (at !== null) {
      const talking = fresh && activity.kind === "talking";
      return {
        at,
        state: talking ? "talking" : "working",
        where: scope,
        lamp: true,
        bubble: talking ? activity.text : null,
      };
    }
  }
  if (pending !== undefined) {
    const scope = scopeOf(pending);
    const layout = world.layout.plots.get(scope);
    const at = scope === SOCIETY ? world.layout.square.bench : layout?.gate;
    if (at !== undefined) {
      return { at, state: "walking", where: scope, lamp: false, bubble: null };
    }
  }
  if (resident !== undefined) {
    const scope = scopeOf(resident);
    const at = spotIn(scope);
    if (at !== null) {
      return { at, state: "idle", where: scope, lamp: true, bubble: null };
    }
  }
  const house = world.layout.houses.get(member.name);
  return {
    at: house?.door ?? world.layout.square.bench,
    state: sleeping ? "sleeping" : "idle",
    where: "home",
    lamp: false,
    bubble: null,
  };
}

/**
 * The world as a pure function of a board snapshot. Nothing here is stored; the scene animates
 * the difference between two results. Every element traces back to a record or an event.
 */
export function worldFrom(snapshot: WorldSnapshot): World {
  const active = snapshot.members.filter(
    (member) => member.status === "active" && member.cli !== null,
  );
  const retired = snapshot.members.filter((member) => member.status === "retired");
  const layout = layoutWorld({
    projects: snapshot.projects.map((project) => ({
      slug: project.slug,
      members: project.members.length,
    })),
    citizens: active.map((member) => member.name),
    memorials: retired.map((member) => member.name),
  });
  const failed = failedMerges(snapshot);
  const harvestsByProject = new Map<string, number>();
  for (const event of snapshot.events) {
    if (event.type === "merge.completed") {
      const project = stringOf(event.payload["project"]);
      if (project !== null) {
        harvestsByProject.set(project, (harvestsByProject.get(project) ?? 0) + 1);
      }
    }
  }

  // Weather is keyed by project or by task; tasks are resolved to their plot.
  const taskPlot = new Map<string, string>();
  for (const project of snapshot.projects) {
    for (const task of snapshot.tasks[project.slug] ?? []) {
      taskPlot.set(task.id, project.slug);
    }
  }
  const weatherByPlot = new Map<string, Weather[]>();
  const pushWeather = (slug: string, weather: Weather): void => {
    const list = weatherByPlot.get(slug) ?? [];
    list.push(weather);
    weatherByPlot.set(slug, list);
  };

  const plots = new Map<string, Plot>();
  const cropPositions = new Map<string, Point>();
  for (const project of snapshot.projects) {
    const plotLayout = layout.plots.get(project.slug);
    if (plotLayout === undefined) continue;
    const tasks = [...(snapshot.tasks[project.slug] ?? [])].toSorted((a, b) =>
      a.createdAt < b.createdAt ? -1 : 1,
    );
    const crops: Crop[] = [];
    tasks.slice(0, plotLayout.cells.length).forEach((task, index) => {
      const at = plotLayout.cells[index];
      if (at === undefined) return;
      cropPositions.set(task.id, at);
      crops.push({
        taskId: task.id,
        title: task.title,
        stage: stageOf(task),
        at,
        claimedBy: task.claimedBy ?? null,
        wilted:
          task.status === "claimed" &&
          task.leaseExpiresAt !== undefined &&
          Date.parse(task.leaseExpiresAt) < snapshot.now,
        marked: failed.has(task.id),
      });
    });
    plots.set(
      project.slug,
      plotFrom(project.slug, project.name, plotLayout, {
        members: project.members,
        crops,
        overflow: Math.max(0, tasks.length - plotLayout.cells.length),
        weather: [],
        harvests: harvestsByProject.get(project.slug) ?? 0,
        knowledge: 0,
      }),
    );
  }

  for (const key of snapshot.scheduler.signals) {
    const { kind, parts } = parseSignal(key);
    const [first = "", second = ""] = parts;
    const kinds: Record<string, WeatherKind> = {
      backlog: "cloud",
      role_gap: "hiring",
      churn: "dust",
      stale_thread: "cobweb",
      blocked_capability: "lock",
      scaled: "frame",
    };
    const weatherKind = kinds[kind];
    if (weatherKind === undefined) continue;
    const byTask = kind === "churn" || kind === "stale_thread" || kind === "blocked_capability";
    const slug = byTask ? taskPlot.get(first) : first;
    if (slug === undefined) continue;
    const plotLayout = layout.plots.get(slug);
    if (plotLayout === undefined) continue;
    const at = byTask
      ? (cropPositions.get(first) ?? plotLayout.gate)
      : weatherKind === "cloud"
        ? { x: plotLayout.rect.x + Math.floor(plotLayout.rect.w / 2), y: plotLayout.rect.y - 1 }
        : weatherKind === "hiring"
          ? (plotLayout.desks[0] ?? plotLayout.gate)
          : plotLayout.barn;
    const label = byTask
      ? WEATHER_LABELS[weatherKind]
      : `${WEATHER_LABELS[weatherKind]}${second.length === 0 ? "" : ` for ${second}`}`;
    pushWeather(slug, { kind: weatherKind, key, at, label });
  }
  for (const [slug, weather] of weatherByPlot) {
    const plot = plots.get(slug);
    if (plot !== undefined) plots.set(slug, { ...plot, weather });
  }

  const placement = {
    plots,
    layout,
    deskIndex: new Map<string, number>(),
    benchIndex: { value: 0 },
  };
  const citizens: Citizen[] = active.map((member) => {
    const placed = placeCitizen(member, snapshot, placement);
    return {
      name: member.name,
      role: member.role,
      cli: member.cli === "codex" ? "codex" : "claude",
      model: member.lastModel ?? member.model ?? null,
      at: placed.at,
      state: placed.state,
      where: placed.where,
      lamp: placed.lamp,
      bubble: placed.bubble === null ? null : firstLine(placed.bubble),
      claims: member.claimsHeld,
      profile: firstLine(
        member.profile
          .split("\n")
          .filter((line) => !line.trim().startsWith("#"))
          .join("\n"),
      ),
      skills: member.skills,
      lastTurn: member.lastTurnOutcome ?? null,
    };
  });

  const houses: House[] = active.map((member) => {
    const house = layout.houses.get(member.name);
    const rect = house?.rect ?? { x: 0, y: 0, w: 1, h: 1 };
    return {
      agent: member.name,
      rect,
      door: house?.door ?? { x: 0, y: 0 },
      lamp: snapshot.scheduler.resident.some((pair) => pair.startsWith(`${member.name}/`)),
    };
  });

  const memorials: Memorial[] = retired.map((member) =>
    memorialFrom(
      member.name,
      member.role,
      member.retiredAt === undefined ? "retired" : `retired ${member.retiredAt.slice(0, 10)}`,
      layout.memorials.get(member.name) ?? { x: 0, y: 0 },
    ),
  );

  const pendingProposals = snapshot.proposals.filter((proposal) => proposal.status === "proposed");
  const recentFailedMerges = snapshot.events.filter(
    (event) =>
      event.type === "merge.failed" &&
      snapshot.now - Date.parse(event.ts) <= FAILED_MERGE_WINDOW_MS,
  ).length;
  const waiting = pendingProposals.length + snapshot.unread + recentFailedMerges;
  const coins = snapshot.events
    .filter((event) => event.type === "turn.completed" && Date.parse(event.ts) >= snapshot.dayStart)
    .reduce((sum, event) => {
      const cost = event.payload["costUsd"];
      return sum + (typeof cost === "number" ? cost : 0);
    }, 0);

  return {
    size: layout.size,
    square: layout.square,
    plots: snapshot.projects
      .map((project) => plots.get(project.slug))
      .filter((plot): plot is Plot => plot !== undefined),
    houses,
    citizens,
    memorials,
    mailbox: {
      flag: waiting > 0,
      waiting,
      proposals: pendingProposals.length,
      unread: snapshot.unread,
      failedMerges: recentFailedMerges,
    },
    notices: pendingProposals.length,
    night: snapshot.scheduler.paused,
    coins,
    library: snapshot.library,
  };
}

/** One line per entity, for the keyboard mirror and the browser session's assertions. */
export function describeWorld(world: World): {
  readonly citizens: readonly string[];
  readonly plots: readonly string[];
  readonly square: readonly string[];
} {
  const citizens = world.citizens.map((citizen) => {
    const doing =
      citizen.state === "working" || citizen.state === "talking"
        ? `working in ${citizen.where}`
        : citizen.state === "walking"
          ? `walking to ${citizen.where}`
          : citizen.state === "sleeping"
            ? "idle for days"
            : citizen.where === "home"
              ? "at home"
              : `at the ${citizen.where === SOCIETY ? "square" : citizen.where}`;
    return `${citizen.name}, ${citizen.role} on ${citizen.cli}: ${doing}`;
  });
  const plots = world.plots.map((plot) => {
    const crops =
      plot.crops.length === 0
        ? "no tasks"
        : plot.crops.map((crop) => `${crop.title} ${crop.stage}`).join(", ");
    const weather =
      plot.weather.length === 0 ? "" : `; weather ${plot.weather.map((w) => w.label).join(", ")}`;
    return `${plot.name}: ${plot.members.length} member(s); ${crops}; ${plot.harvests} harvest(s)${weather}`;
  });
  const square = [
    `Mailbox: ${world.mailbox.waiting} waiting`,
    `Town hall: ${world.notices} proposal(s) to decide`,
    `Library: ${world.library.skills} skill(s), ${world.library.knowledge} topic(s)`,
    world.night ? "Clock: stopped, the society is paused" : "Clock: running",
  ];
  return { citizens, plots, square };
}
