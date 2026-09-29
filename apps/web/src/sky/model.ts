import { SOCIETY_SCOPE, type CliKind, type Member, type Project } from "@stellaris/shared";
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
  /** The sphere's radius: its citizens and their names fit inside. */
  readonly radius: number;
}

export interface Star {
  readonly name: string;
  readonly cli: CliKind;
  readonly state: StarState;
  /** A warm session is held for the citizen. */
  readonly resident: boolean;
  readonly anchor: string;
  readonly x: number;
  readonly y: number;
}

/** Where everything sits, in world units around the origin. The scene eases toward it. */
export interface SkyModel {
  readonly anchors: readonly Anchor[];
  readonly stars: readonly Star[];
  /** Every sphere and its name fits in this radius around the origin. */
  readonly radius: number;
}

export interface SkySnapshot {
  readonly members: readonly Member[];
  readonly projects: readonly Project[];
  readonly scheduler: SchedulerView;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const STAR_SPACING = 68;
/** Room inside a sphere beyond its outermost star: the star itself and its name below it. */
const SPHERE_PAD = 44;
const SPHERE_MIN = 58;
/** Room outside a sphere for the project's name under it. */
const NAME_ROOM = 26;
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

/** The first scope listed for each agent in `agent/scope` pairs. */
function scopesByAgent(pairs: readonly string[]): Map<string, string> {
  const scopes = new Map<string, string>();
  for (const pair of pairs.toSorted()) {
    const [agent, scope] = pair.split("/");
    if (agent !== undefined && scope !== undefined && !scopes.has(agent)) {
      scopes.set(agent, scope);
    }
  }
  return scopes;
}

/**
 * The sky for a snapshot of the board. Projects sit on a ring in creation order and the society
 * at the center; a citizen is at the scope of its running turn, else of its queued turn, else at
 * its first project, else at the society. Pure, so the same board always draws the same sky.
 */
export function skyModel(snapshot: SkySnapshot): SkyModel {
  const projects = snapshot.projects.toSorted(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug),
  );
  const slugs = new Set(projects.map((project) => project.slug));

  const running = scopesByAgent(snapshot.scheduler.running);
  const pending = scopesByAgent(snapshot.scheduler.pending);
  const resident = new Set(snapshot.scheduler.resident.map((pair) => pair.split("/")[0]));
  const citizens = snapshot.members
    .filter((member): member is Member & { cli: CliKind } => member.cli !== null)
    .filter((member) => member.status === "active")
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((member) => {
      const wanted =
        running.get(member.name) ??
        pending.get(member.name) ??
        member.memberships.find((slug) => slugs.has(slug)) ??
        SOCIETY_SCOPE;
      const state: StarState = running.has(member.name)
        ? "working"
        : pending.has(member.name)
          ? "queued"
          : "idle";
      return { member, state, scope: slugs.has(wanted) ? wanted : SOCIETY_SCOPE };
    });
  const counts = new Map<string, number>();
  for (const { scope } of citizens) {
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }

  const society: Anchor = {
    id: SOCIETY_SCOPE,
    label: "society",
    kind: "society",
    x: 0,
    y: 0,
    radius: sphereRadius(counts.get(SOCIETY_SCOPE) ?? 0),
  };
  const anchors: Anchor[] = [society, ...placeProjects(projects, counts, society)];
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));

  const slots = new Map<string, number>();
  const stars = citizens.map(({ member, state, scope }): Star => {
    const anchor = byId.get(scope) ?? society;
    const slot = slots.get(anchor.id) ?? 0;
    slots.set(anchor.id, slot + 1);
    // Sunflower packing: the first citizen at the center, the rest spiralling out without overlap.
    const distance = STAR_SPACING * Math.sqrt(slot);
    const angle = slot * GOLDEN_ANGLE - Math.PI / 2;
    return {
      name: member.name,
      cli: member.cli,
      state,
      resident: resident.has(member.name),
      anchor: anchor.id,
      x: Math.round(anchor.x + distance * Math.cos(angle)),
      y: Math.round(anchor.y + distance * Math.sin(angle)),
    };
  });

  const radius = Math.max(
    ...anchors.map((anchor) => Math.hypot(anchor.x, anchor.y) + footprint(anchor.radius)),
  );
  return { anchors, stars, radius: Math.round(radius + MARGIN) };
}

/**
 * Projects on rings around the core, the first ring holding eight and each further one four more.
 * On a ring every project gets a slice of the circle as wide as its sphere, the first slice
 * centered at the top, and the ring is pushed out until neighbouring spheres, the core, and the
 * ring inside all clear each other.
 */
function placeProjects(
  projects: readonly Project[],
  counts: ReadonlyMap<string, number>,
  society: Anchor,
): Anchor[] {
  const placed: Anchor[] = [];
  let reach = footprint(society.radius);
  let capacity = FIRST_RING;
  for (let start = 0, ring = 0; start < projects.length; ring += 1) {
    const members = projects.slice(start, start + capacity);
    start += capacity;
    capacity += 4;
    const radii = members.map((project) => sphereRadius(counts.get(project.slug) ?? 0));
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
