import type { Message, Task, TurnDispatch, TurnRecord } from "@stellaris/shared";
import { renderOnboardingPreamble, type OnboardingContext } from "./render.js";

export interface TurnPromptInput {
  readonly dispatch: TurnDispatch;
  readonly messages: readonly Message[];
  readonly heldClaims: readonly Task[];
  readonly lastTurn: TurnRecord | null;
  readonly onboarding: OnboardingContext | null;
}

const MAX_BODY_CHARS = 1_500;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_BODY_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_BODY_CHARS)}\n[... truncated]`;
}

/** The digest injected into every turn. This is the only push channel from the board to an agent. */
export function buildTurnPrompt(input: TurnPromptInput): string {
  const { dispatch } = input;
  const lines: string[] = [];
  lines.push(`# Turn for ${dispatch.agent} on project ${dispatch.project}`);
  lines.push("");
  const from = dispatch.trigger.from === undefined ? "" : ` from ${dispatch.trigger.from}`;
  lines.push(`Trigger: ${dispatch.trigger.kind}${from}. ${dispatch.trigger.reason}`.trim());
  if (dispatch.trigger.taskId !== undefined) {
    lines.push(`Task in question: ${dispatch.trigger.taskId}`);
  }
  if (dispatch.trigger.kind === "ops_event") {
    lines.push(
      "Operations signals arrived; the ops posts below carry them. Decide whether a proposal is warranted, and stay silent if not.",
    );
  }

  if (input.onboarding !== null) {
    lines.push("", "## First turn", "", renderOnboardingPreamble(input.onboarding));
  }

  const last = input.lastTurn;
  if (last !== null && (last.exitReason === "error" || last.exitReason === "timeout")) {
    lines.push(
      "",
      "## Your previous turn did not finish",
      "",
      `It ended with ${last.exitReason}${last.error === null ? "" : `: ${last.error}`}.`,
      "The worktree may hold uncommitted changes. Run git status before doing anything else.",
    );
  }

  lines.push("", "## Claims you hold", "");
  if (input.heldClaims.length === 0) {
    lines.push("None.");
  } else {
    for (const task of input.heldClaims) {
      lines.push(
        `- ${task.id} "${task.title}" (${task.status}, lease until ${task.leaseExpiresAt ?? "unknown"})`,
      );
    }
  }

  lines.push("", `## Inbox (${input.messages.length} unread)`, "");
  if (input.messages.length === 0) {
    lines.push("Nothing new.");
  } else {
    for (const message of input.messages) {
      const where =
        message.thread === undefined
          ? message.channel
          : `${message.channel} thread ${message.thread}`;
      lines.push(
        `### [${message.ts}] ${where} from @${message.author} (message ${message.id})`,
        "",
        clip(message.body),
        "",
      );
    }
  }

  lines.push(
    "## What to do",
    "",
    "Act on the inbox and your claims through the board tools. Post replies with post_message, claim work with claim_task, submit with update_task, and ask for what the society lacks with propose. Silence is allowed when nothing needs a reply. End with the status object.",
  );
  return `${lines.join("\n")}\n`;
}
