import type { BoardEvent, Member, Project, Proposal, Task } from "@stellaris/shared";

/** A position in tiles. The scene multiplies by the tile size; nothing here knows about pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect extends Point {
  readonly w: number;
  readonly h: number;
}

/** What the world is built from: the same data the drawers read, nothing more. */
export interface WorldSnapshot {
  readonly projects: readonly Project[];
  /** The roster, retired members included; the owner is a member too but has no sprite. */
  readonly members: readonly Member[];
  readonly tasks: Readonly<Record<string, readonly Task[]>>;
  readonly scheduler: SchedulerSnapshot;
  readonly proposals: readonly Proposal[];
  /** Unread items in the owner's inbox. */
  readonly unread: number;
  /** Recent board events, for coins and failed merges. */
  readonly events: readonly BoardEvent[];
  /** What each citizen was last seen doing on the live stream. */
  readonly activity: Readonly<Record<string, Activity>>;
  readonly library: { readonly skills: number; readonly knowledge: number };
  readonly now: number;
  /** Local midnight in milliseconds, so the coin count is a day's spend wherever the owner sits. */
  readonly dayStart: number;
}

export interface SchedulerSnapshot {
  readonly paused: boolean;
  readonly running: readonly string[];
  readonly pending: readonly string[];
  readonly resident: readonly string[];
  /** Keys of the operations conditions that hold right now. */
  readonly signals: readonly string[];
}

export interface Activity {
  readonly kind: "working" | "talking";
  readonly text: string | null;
  readonly at: number;
}

export type CropStage = "seed" | "growing" | "ripe" | "harvested" | "withered" | "fenced";

export interface Crop {
  readonly taskId: string;
  readonly title: string;
  readonly stage: CropStage;
  readonly at: Point;
  readonly claimedBy: string | null;
  /** A claim past its lease. */
  readonly wilted: boolean;
  /** The last merge of this task failed. */
  readonly marked: boolean;
}

export type WeatherKind = "cloud" | "hiring" | "dust" | "cobweb" | "lock" | "frame";

export interface Weather {
  readonly kind: WeatherKind;
  readonly key: string;
  readonly at: Point;
  readonly label: string;
}

export interface Plot {
  readonly slug: string;
  readonly name: string;
  readonly rect: Rect;
  readonly sign: Point;
  readonly gate: Point;
  readonly barn: Rect;
  readonly members: readonly string[];
  readonly crops: readonly Crop[];
  /** Tasks beyond the field's capacity, shown as a count on the sign. */
  readonly overflow: number;
  readonly weather: readonly Weather[];
  readonly harvests: number;
  readonly knowledge: number;
}

export interface House {
  readonly agent: string;
  readonly rect: Rect;
  readonly door: Point;
  readonly lamp: boolean;
}

export type CitizenState = "idle" | "walking" | "working" | "talking" | "sleeping";

export interface Citizen {
  readonly name: string;
  readonly role: string;
  readonly cli: "claude" | "codex";
  readonly model: string | null;
  readonly at: Point;
  readonly state: CitizenState;
  /** A project slug, `society`, or `home`. */
  readonly where: string;
  readonly lamp: boolean;
  readonly bubble: string | null;
  readonly claims: number;
  readonly profile: string;
  readonly skills: readonly string[];
  readonly lastTurn: string | null;
}

export interface Memorial {
  readonly agent: string;
  readonly role: string;
  readonly reason: string;
  readonly at: Point;
}

export interface Square {
  readonly rect: Rect;
  readonly frontDesk: Rect;
  readonly townHall: Rect;
  readonly library: Rect;
  readonly mailbox: Point;
  readonly clock: Point;
  readonly bench: Point;
}

export interface Mailbox {
  readonly flag: boolean;
  readonly waiting: number;
  readonly proposals: number;
  readonly unread: number;
  readonly failedMerges: number;
}

export interface World {
  readonly size: { readonly w: number; readonly h: number };
  readonly square: Square;
  readonly plots: readonly Plot[];
  readonly houses: readonly House[];
  readonly citizens: readonly Citizen[];
  readonly memorials: readonly Memorial[];
  readonly mailbox: Mailbox;
  readonly notices: number;
  readonly night: boolean;
  readonly coins: number;
  readonly library: { readonly skills: number; readonly knowledge: number };
}
