import {
  currentStage,
  SOCIETY_SCOPE,
  type CliKind,
  type Member,
  type Project,
  type Task,
} from "@stellaris/shared";
import { assigneeOf, phaseOf, type TaskPhase } from "../board/tasks.js";
import type { SchedulerView } from "../lib/api.js";

export type StarState = "idle" | "queued" | "working";

/** A place citizens gather: the society at the center, or a project on a ring around it. */
export interface Anchor {
  /** A project slug, or the society scope. */
  readonly id: string;
  readonly label: string;
  readonly kind: "society" | "project";
  readonly x: number;
  readonly y: number;
  /** The sphere's radius: everyone who may gather there, and their names, fit inside. */
  readonly radius: number;
}

export interface Star {
  /**
   * Unique in the sky: the citizen's name for its star at the core, and `name/scope` for a turn
   * in a project, since a citizen in turns in two projects has a star in each.
   */
  readonly id: string;
  readonly name: string;
  readonly cli: CliKind;
  readonly state: StarState;
  /** A warm session is held for the citizen. */
  readonly resident: boolean;
  readonly anchor: string;
  /** Where a queued turn will run; the star waits at the core until it starts. */
  readonly queuedFor: string | null;
  readonly x: number;
  readonly y: number;
}

/** A task in play: a mark orbiting its project's sphere, in its phase's color. */
export interface TaskMark {
  /** The task's id. */
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly phase: Exclude<TaskPhase, "done" | "abandoned">;
  /** The current stage's name. */
  readonly stage: string;
  /** Who holds the current stage, if anyone does. */
  readonly holder: string | null;
  /** Who may take the current stage while nobody holds it, in words. */
  readonly waitingFor: string | null;
  /** The holder's star when it is in a turn at the task's project: the link joins the two. */
  readonly linked: string | null;
  readonly x: number;
  readonly y: number;
}

/** Where everything sits, in world units around the origin. The scene eases toward it. */
export interface SkyModel {
  readonly anchors: readonly Anchor[];
  readonly stars: readonly Star[];
  readonly tasks: readonly TaskMark[];
  /** Every sphere and its name fits in this radius around the origin. */
  readonly radius: number;
}

export interface SkySnapshot {
  readonly members: readonly Member[];
  readonly projects: readonly Project[];
  readonly scheduler: SchedulerView;
  /** Every project's tasks; the ones in play orbit their project. */
  readonly tasks?: readonly Task[] | undefined;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const STAR_SPACING = 68;
/** Room inside a sphere beyond its outermost star: the star itself and its name below it. */
const SPHERE_PAD = 44;
const SPHERE_MIN = 58;
/** Room outside a sphere for the project's name under it, which also holds the task orbit. */
const NAME_ROOM = 26;
/** How far outside its sphere a project's tasks orbit. */
const TASK_ORBIT = 13;
/** The angle between neighbouring tasks on the orbit. */
const TASK_STEP = 0.3;
/** Tasks fill the orbit from the top down both sides and stop short of the name at the bottom. */
const TASK_ARC = 1.5 * Math.PI;
/** The least space between two spheres, or a sphere and the core. */
const GAP = 28;
const RING_MIN = 280;
/** Projects on the innermost ring; each ring further out holds four more. */
const FIRST_RING = 8;
const MARGIN = 40;

function sphereRadius(citizens: number): number {
  return Math.max(SPHERE_MIN, STAR_SPACING * Math.sqrt(Math.max(0, citizens - 1)) + SPHERE_PAD);
}

/** The space a sphere claims from its center: the sphere and the name beneath it. */
function footprint(radius: number): number {
  return radius + NAME_ROOM;
}

/** The scopes in `agent/scope` pairs, by agent. */
function scopesByAgent(pairs: readonly string[]): Map<string, string[]> {
  const scopes = new Map<string, string[]>();
  for (const pair of pairs.toSorted()) {
    const [agent, scope] = pair.split("/");
    if (agent !== undefined && scope !== undefined) {
      scopes.set(agent, [...(scopes.get(agent) ?? []), scope]);
    }
  }
  return scopes;
}

interface Placement {
  readonly id: string;
  readonly member: Member & { cli: CliKind };
  readonly state: StarState;
  readonly scope: string;
  readonly queuedFor: string | null;
}

/**
 * The sky for a snapshot of the board. Projects sit on rings in creation order around the
 * society at the center. A star away from the core is a turn in progress: a citizen has one star
 * in each project it is in a turn at, and rests at the core otherwise, queued or idle. Spheres
 * are sized for everyone who may gather there and every citizen keeps its seat in each, so a turn
 * starting moves one star and nothing else.
 * Pure, so the same board always draws the same sky.
 */
export function skyModel(snapshot: SkySnapshot): SkyModel {
  // An archived project has no members and takes no work, so it has no sphere.
  const projects = snapshot.projects
    .filter((project) => project.archived === undefined)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug));
  const slugs = new Set(projects.map((project) => project.slug));
  const placeOf = (scope: string): string => (slugs.has(scope) ? scope : SOCIETY_SCOPE);

  const running = scopesByAgent(snapshot.scheduler.running);
  const pending = scopesByAgent(snapshot.scheduler.pending);
  const resident = new Set(snapshot.scheduler.resident.map((pair) => pair.split("/")[0]));
  const citizens = snapshot.members
    .filter((member): member is Member & { cli: CliKind } => member.cli !== null)
    .filter((member) => member.status === "active")
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const placements = citizens.flatMap((member): Placement[] => {
    const turns = [...new Set((running.get(member.name) ?? []).map(placeOf))];
    if (turns.length > 0) {
      return turns.map((scope) => ({
        id: scope === SOCIETY_SCOPE ? member.name : `${member.name}/${scope}`,
        member,
        state: "working",
        scope,
        queuedFor: null,
      }));
    }
    const queued = pending.get(member.name)?.[0];
    return [
      {
        id: member.name,
        member,
        state: queued === undefined ? "idle" : "queued",
        scope: SOCIETY_SCOPE,
        queuedFor: queued === undefined ? null : placeOf(queued),
      },
    ];
  });

  // Every citizen has a seat at the core and each member one at its project, in name order, with
  // visiting non-members after them; a star leaving empties its seat and moves nobody else.
  const seats = new Map<string, Map<string, number>>([
    [SOCIETY_SCOPE, new Map(citizens.map((member, index) => [member.name, index]))],
  ]);
  for (const project of projects) {
    const members = citizens.filter((member) => member.memberships.includes(project.slug));
    const visitors = placements
      .filter((placement) => placement.scope === project.slug)
      .map((placement) => placement.member)
      .filter((member) => !member.memberships.includes(project.slug));
    seats.set(
      project.slug,
      new Map([...members, ...visitors].map((member, index) => [member.name, index])),
    );
  }
  const room = new Map([...seats].map(([scope, taken]) => [scope, taken.size]));

  const society: Anchor = {
    id: SOCIETY_SCOPE,
    label: "society",
    kind: "society",
    x: 0,
    y: 0,
    radius: sphereRadius(room.get(SOCIETY_SCOPE) ?? 0),
  };
  const anchors: Anchor[] = [society, ...placeProjects(projects, room, society)];
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));

  const stars = placements.map(({ id, member, state, scope, queuedFor }): Star => {
    const anchor = byId.get(scope) ?? society;
    const slot = seats.get(anchor.id)?.get(member.name) ?? 0;
    // Sunflower packing: the first seat at the center, the rest spiralling out without overlap.
    const distance = STAR_SPACING * Math.sqrt(slot);
    const angle = slot * GOLDEN_ANGLE - Math.PI / 2;
    return {
      id,
      name: member.name,
      cli: member.cli,
      state,
      resident: resident.has(member.name),
      anchor: anchor.id,
      queuedFor,
      x: Math.round(anchor.x + distance * Math.cos(angle)),
      y: Math.round(anchor.y + distance * Math.sin(angle)),
    };
  });

  const tasks = placeTasks(snapshot.tasks ?? [], anchors, stars);
  const radius = Math.max(
    ...anchors.map((anchor) => Math.hypot(anchor.x, anchor.y) + footprint(anchor.radius)),
  );
  return { anchors, stars, tasks, radius: Math.round(radius + MARGIN) };
}

/**
 * A project's tasks in play on an orbit just outside its sphere, oldest first: the first at the
 * top, the next ones alternating right and left of it, so a new task takes the next place and none
 * moves. The orbit tightens when a project has more tasks than fit the arc.
 */
function placeTasks(
  tasks: readonly Task[],
  anchors: readonly Anchor[],
  stars: readonly Star[],
): TaskMark[] {
  const marks: TaskMark[] = [];
  for (const anchor of anchors) {
    if (anchor.kind !== "project") {
      continue;
    }
    const inPlay = tasks
      .filter((task) => task.project === anchor.id)
      .flatMap((task) => {
        const phase = phaseOf(task);
        return phase === "done" || phase === "abandoned" ? [] : [{ task, phase }];
      })
      .toSorted((a, b) => a.task.id.localeCompare(b.task.id));
    const step = Math.min(TASK_STEP, TASK_ARC / Math.max(1, inPlay.length));
    const orbit = anchor.radius + TASK_ORBIT;
    inPlay.forEach(({ task, phase }, index) => {
      const side = index % 2 === 0 ? 1 : -1;
      const angle = -Math.PI / 2 + side * Math.ceil(index / 2) * step;
      const holder = phase === "landing" ? null : (task.claimedBy ?? null);
      const stage = currentStage(task);
      const linked =
        holder === null
          ? null
          : (stars.find((star) => star.name === holder && star.anchor === anchor.id)?.id ?? null);
      marks.push({
        id: task.id,
        title: task.title,
        project: anchor.id,
        phase,
        stage: stage?.name ?? task.stage,
        holder,
        waitingFor:
          holder === null && phase !== "landing" && stage !== undefined ? assigneeOf(stage) : null,
        linked,
        x: Math.round(anchor.x + orbit * Math.cos(angle)),
        y: Math.round(anchor.y + orbit * Math.sin(angle)),
      });
    });
  }
  return marks;
}

/**
 * The star a live event belongs to: the citizen's star at the event's scope when it is in a turn
 * there, else its only star. The stream names a scope the sky may not have caught up with yet.
 */
export function starOf(model: SkyModel, agent: string, scope: string): string | null {
  const stars = model.stars.filter((star) => star.name === agent);
  return (stars.find((star) => star.anchor === scope) ?? stars[0])?.id ?? null;
}

/**
 * Projects on rings around the core, the first ring holding eight and each further one four more.
 * On a ring every project gets a slice of the circle as wide as its sphere, the first slice
 * centered at the top, and the ring is pushed out until neighbouring spheres, the core, and the
 * ring inside all clear each other.
 */
function placeProjects(
  projects: readonly Project[],
  room: ReadonlyMap<string, number>,
  society: Anchor,
): Anchor[] {
  const placed: Anchor[] = [];
  let reach = footprint(society.radius);
  let capacity = FIRST_RING;
  for (let start = 0, ring = 0; start < projects.length; ring += 1) {
    const members = projects.slice(start, start + capacity);
    start += capacity;
    capacity += 4;
    const radii = members.map((project) => sphereRadius(room.get(project.slug) ?? 0));
    const feet = radii.map(footprint);
    const widths = feet.map((foot) => 2 * foot + GAP);
    const total = widths.reduce((sum, width) => sum + width, 0);
    const slices = widths.map((width) => (2 * Math.PI * width) / total);
    // Rings further out start half a slice later, so their spheres sit between the inner ones.
    let edge = -Math.PI / 2 - (slices[0] ?? 0) / 2 + (ring === 0 ? 0 : Math.PI / members.length);
    const angles = slices.map((slice) => {
      const center = edge + slice / 2;
      edge += slice;
      return center;
    });
    let distance = Math.max(ring === 0 ? RING_MIN : 0, reach + Math.max(...feet) + GAP);
    if (members.length > 1) {
      for (let i = 0; i < members.length; i += 1) {
        const j = (i + 1) % members.length;
        const apart = ((slices[i] ?? 0) + (slices[j] ?? 0)) / 2;
        const needed = ((feet[i] ?? 0) + (feet[j] ?? 0) + GAP) / (2 * Math.sin(apart / 2));
        distance = Math.max(distance, needed);
      }
    }
    members.forEach((project, index) => {
      const angle = angles[index] ?? 0;
      placed.push({
        id: project.slug,
        label: project.name,
        kind: "project",
        x: Math.round(distance * Math.cos(angle)),
        y: Math.round(distance * Math.sin(angle)),
        radius: Math.round(radii[index] ?? SPHERE_MIN),
      });
    });
    reach = distance + Math.max(...feet);
  }
  return placed;
}
