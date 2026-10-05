import { randomBytes, randomInt } from "node:crypto";
import { BoardError, type Actor, type Board } from "@stellaris/board-core";
import type {
  Name,
  PendingEnrollment,
  Runner,
  RunnerEnrollment,
  RunnerEnrollRequest,
  RunnerEnrollStatus,
} from "@stellaris/shared";

/** How long an enrollment waits for the user before the runner asks again. */
export const ENROLLMENT_TTL_MS = 10 * 60_000;
/** How often a runner asks whether it was approved, unless the desk is told otherwise. */
const POLL_INTERVAL_MS = 3_000;
/**
 * Enrollments waiting at once. Asking needs no token, so the cap keeps strangers from growing the
 * desk without bound, and the rate limit per address keeps any one of them to a few of its places;
 * a full desk refuses new asks until some expire.
 */
const MAX_WAITING = 100;
/** No vowels, so no code spells a word, and nothing read as another: no 0, O, 1, or I. */
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

interface Enrollment {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly request: RunnerEnrollRequest;
  readonly requestedAt: number;
  readonly expiresAt: number;
  status: RunnerEnrollStatus;
}

function codeHalf(): string {
  return Array.from({ length: 4 }, () =>
    CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length)),
  ).join("");
}

function userCode(): string {
  return `${codeHalf()}-${codeHalf()}`;
}

/** A code as typed: case and separators do not matter. */
function normalized(code: string): string {
  return code.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

/**
 * Runners asking to join the society, held in memory until the user approves or denies them on
 * the board or they expire. A runner asks with what its machine is and gets two codes: a device
 * code, which only it knows and polls with, and a short user code, which it prints for the user to
 * approve. Approval registers the runner and hands its token to the runner's next poll, once.
 */
export class EnrollmentDesk {
  private readonly enrollments = new Map<string, Enrollment>();
  private readonly now: () => number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly board: Board,
    options: { now?: (() => number) | undefined; pollIntervalMs?: number | undefined } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  open(request: RunnerEnrollRequest): RunnerEnrollment {
    this.prune();
    const waiting = [...this.enrollments.values()].filter(
      (each) => each.status.status === "pending",
    );
    if (waiting.length >= MAX_WAITING) {
      throw new BoardError(
        "INVALID_STATE",
        `${MAX_WAITING} runners already wait for approval; try again once some have expired`,
      );
    }
    const enrollment: Enrollment = {
      deviceCode: randomBytes(32).toString("base64url"),
      userCode: userCode(),
      request,
      requestedAt: this.now(),
      expiresAt: this.now() + ENROLLMENT_TTL_MS,
      status: { status: "pending" },
    };
    this.enrollments.set(enrollment.deviceCode, enrollment);
    return {
      deviceCode: enrollment.deviceCode,
      userCode: enrollment.userCode,
      expiresAt: new Date(enrollment.expiresAt).toISOString(),
      intervalMs: this.pollIntervalMs,
    };
  }

  /**
   * Where the runner's enrollment stands, or null once it is unknown or expired. An approval or a
   * denial is told once and then forgotten, so the token never travels twice.
   */
  poll(deviceCode: string): RunnerEnrollStatus | null {
    this.prune();
    const enrollment = this.enrollments.get(deviceCode);
    if (enrollment === undefined) {
      return null;
    }
    if (enrollment.status.status !== "pending") {
      this.enrollments.delete(deviceCode);
    }
    return enrollment.status;
  }

  /** The enrollments waiting for the user, newest first. */
  waiting(): PendingEnrollment[] {
    this.prune();
    return [...this.enrollments.values()]
      .filter((each) => each.status.status === "pending")
      .toSorted((a, b) => b.requestedAt - a.requestedAt)
      .map((each) => ({
        userCode: each.userCode,
        hostname: each.request.hostname,
        os: each.request.os,
        clis: each.request.clis,
        capabilities: each.request.capabilities,
        version: each.request.version,
        requestedAt: new Date(each.requestedAt).toISOString(),
        expiresAt: new Date(each.expiresAt).toISOString(),
      }));
  }

  /** Registers the runner a waiting enrollment asked for, under `name`, for its next poll. */
  async approve(actor: Actor, code: string, name: Name): Promise<Runner> {
    const enrollment = this.waitingFor(code);
    const { runner, token } = await this.board.addRunner(actor, name, {
      hostname: enrollment.request.hostname,
    });
    enrollment.status = { status: "approved", name: runner.name, token };
    return runner;
  }

  deny(code: string): void {
    this.waitingFor(code).status = { status: "denied" };
  }

  private waitingFor(code: string): Enrollment {
    this.prune();
    const wanted = normalized(code);
    for (const enrollment of this.enrollments.values()) {
      if (enrollment.status.status === "pending" && normalized(enrollment.userCode) === wanted) {
        return enrollment;
      }
    }
    throw new BoardError("NOT_FOUND", `no runner waits for approval with the code ${code}`);
  }

  private prune(): void {
    for (const [deviceCode, enrollment] of this.enrollments) {
      if (enrollment.expiresAt <= this.now()) {
        this.enrollments.delete(deviceCode);
      }
    }
  }
}
