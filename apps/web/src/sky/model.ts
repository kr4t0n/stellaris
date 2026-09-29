import { SOCIETY_SCOPE, type CliKind, type Member, type Project } from "@stellaris/shared";
import type { SchedulerView } from "../lib/api.js";

export type StarState = "idle" | "queued" | "working";

/** A place citizens gather: the society at the center, or a project on the ring around it. */
export interface Anchor {
  /** A project slug, or the society scope. */
  readonly id: string;
  readonly label: string;
  readonly kind: "society" | "project";
  readonly x: number;
  readonly y: number;
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
  /** Every anchor and star fits in this radius, with a margin for labels. */
  readonly radius: number;
}

export interface SkySnapshot {
  readonly members: readonly Member[];
  readonly projects: readonly Project[];
  readonly scheduler: SchedulerView;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const STAR_SPACING = 68;
const RING_MIN = 300;
const RING_PER_PROJECT = 34;
const MARGIN = 140;

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
  const ring = projects.length === 0 ? 0 : Math.max(RING_MIN, RING_PER_PROJECT * projects.length);
  const society: Anchor = { id: SOCIETY_SCOPE, label: "society", kind: "society", x: 0, y: 0 };
  const anchors: Anchor[] = [
    society,
    ...projects.map((project, index): Anchor => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / projects.length;
      return {
        id: project.slug,
        label: project.name,
        kind: "project",
        x: Math.round(ring * Math.cos(angle)),
        y: Math.round(ring * Math.sin(angle)),
      };
    }),
  ];
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));

  const running = scopesByAgent(snapshot.scheduler.running);
  const pending = scopesByAgent(snapshot.scheduler.pending);
  const resident = new Set(snapshot.scheduler.resident.map((pair) => pair.split("/")[0]));
  const citizens = snapshot.members
    .filter((member): member is Member & { cli: CliKind } => member.cli !== null)
    .filter((member) => member.status === "active")
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const placed = citizens.map((member) => {
    const scope =
      running.get(member.name) ??
      pending.get(member.name) ??
      member.memberships.find((slug) => byId.has(slug)) ??
      SOCIETY_SCOPE;
    const state: StarState = running.has(member.name)
      ? "working"
      : pending.has(member.name)
        ? "queued"
        : "idle";
    return { member, state, anchor: byId.get(scope) ?? society };
  });

  const slots = new Map<string, number>();
  let reach = 0;
  const stars = placed.map(({ member, state, anchor }): Star => {
    const slot = slots.get(anchor.id) ?? 0;
    slots.set(anchor.id, slot + 1);
    // Sunflower packing: the first citizen at the center, the rest spiralling out without overlap.
    const distance = STAR_SPACING * Math.sqrt(slot);
    const angle = slot * GOLDEN_ANGLE - Math.PI / 2;
    const x = anchor.x + distance * Math.cos(angle);
    const y = anchor.y + distance * Math.sin(angle);
    reach = Math.max(reach, Math.hypot(x, y));
    return {
      name: member.name,
      cli: member.cli,
      state,
      resident: resident.has(member.name),
      anchor: anchor.id,
      x: Math.round(x),
      y: Math.round(y),
    };
  });

  return { anchors, stars, radius: Math.max(ring, reach) + MARGIN };
}
