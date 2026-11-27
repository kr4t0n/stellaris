import {
  CliQuotaSchema,
  CronFrontmatterSchema,
  TaskFrontmatterSchema,
  TriggerSchema,
  type TurnRecord,
} from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { buildTurnPrompt, sessionAfresh } from "./prompt.js";

/** A project as the board lists it, placed on a runner or not yet. */
function listedProject(slug: string, runner?: string) {
  return {
    slug,
    name: slug,
    repo: null,
    defaultBranch: "main",
    channels: ["general"],
    archivedChannels: [],
    members: [],
    approvers: [],
    requiredCapabilities: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    onDone: "none" as const,
    ...(runner === undefined ? {} : { runner }),
  };
}

/** A home turn of eng-1's on pod that completed in session s-1, but for `fields`. */
function turn(fields: Partial<TurnRecord>): TurnRecord {
  return {
    agent: "eng-1",
    project: "society",
    runner: "pod",
    cli: "claude",
    session: "s-1",
    trigger: TriggerSchema.parse({ kind: "manual", reason: "work" }),
    startedAt: "2026-09-28T09:00:00.000Z",
    endedAt: "2026-09-28T09:05:00.000Z",
    exitReason: "completed",
    status: null,
    error: null,
    usage: null,
    costUsd: 0,
    toolCalls: 0,
    model: null,
    ...fields,
  };
}

/** The notice of a previous turn that did not finish, with its line on the cause. */
function notice(line: string): string {
  return `## Your previous turn did not finish\n\n${line}\nThe worktree may hold uncommitted changes.`;
}

/** The notice for a failure that was not the citizen's, naming its cause. */
function cutOff(cause: string): string {
  return notice(
    `It was cut off by ${cause}, which is not yours to fix or look into: carry on with the work.`,
  );
}

const cronlessDispatch = {
  agent: "eng-1",
  project: "demo",
  trigger: TriggerSchema.parse({ kind: "heartbeat", reason: "heartbeat" }),
  priority: 0,
  onboarding: false,
};

/** A top-level post in demo's general. */
function generalPost(id: string, body: string) {
  return {
    id,
    author: "rev-1",
    channel: "demo/general",
    ts: "2026-09-28T10:00:00.000Z",
    mentions: [],
    body,
  };
}

/** A heartbeat's prompt, given the instructions it carries as changed, if any. */
function promptWith(changedInstructions?: string | null): string {
  return buildTurnPrompt({
    dispatch: cronlessDispatch,
    messages: [],
    heldClaims: [],
    lastTurn: null,
    onboarding: null,
    ...(changedInstructions === undefined ? {} : { changedInstructions }),
  });
}

/** eng-1's prompt for a wake with this trigger and these tasks done merged into it. */
function donePrompt(trigger: object, tasksDone?: string[]): string {
  return buildTurnPrompt({
    dispatch: {
      ...cronlessDispatch,
      trigger: TriggerSchema.parse(trigger),
      priority: 1,
      ...(tasksDone === undefined ? {} : { tasksDone }),
    },
    messages: [],
    heldClaims: [],
    lastTurn: null,
    onboarding: null,
  });
}

/** eng-1's prompt for a wake with this trigger and these proposals decided merged into it. */
function decidedPrompt(trigger: object, proposalsDecided?: string[]): string {
  return buildTurnPrompt({
    dispatch: {
      ...cronlessDispatch,
      trigger: TriggerSchema.parse(trigger),
      priority: 1,
      ...(proposalsDecided === undefined ? {} : { proposalsDecided }),
    },
    messages: [],
    heldClaims: [],
    lastTurn: null,
    onboarding: null,
  });
}

describe("buildTurnPrompt", () => {
  it("tells the time in the society's zone, and quotes each cron that woke the turn", () => {
    const cron = {
      ...CronFrontmatterSchema.parse({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        title: "Check the deploy",
        agent: "eng-1",
        scope: "demo",
        channel: "dev",
        schedule: { cron: "0 * * * *" },
        createdBy: "user",
        createdAt: "2026-10-10T08:00:00.000Z",
        since: "2026-10-10T08:00:00.000Z",
        lastFiredAt: "2026-10-10T10:00:00.000Z",
        lastRun: {
          turnId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          at: "2026-10-10T09:02:00.000Z",
          outcome: "failed",
        },
      }),
      note: "Read the deploy log and post what changed.",
    };
    const once = {
      ...cron,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      title: "Look again",
      schedule: { at: "2026-10-10T10:00:00.000Z" },
      ended: { at: "2026-10-10T10:00:00.000Z", by: "board", reason: "fired once, as set" },
      note: "Is the fix live?",
    };
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "eng-1",
        project: "demo",
        channel: "dev",
        trigger: TriggerSchema.parse({ kind: "cron", reason: 'cron "Check the deploy" came due' }),
        priority: 1,
        onboarding: false,
        crons: [cron.id, once.id],
      },
      clock: { now: new Date("2026-10-10T10:00:00.000Z"), timeZone: "Asia/Shanghai" },
      crons: [cron, once],
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
    });
    expect(prompt).toContain(
      "It is 2026-10-10T10:00:00.000Z now, Saturday 2026-10-10 18:00 in the society's time zone, Asia/Shanghai.",
    );
    expect(prompt).toContain("A cron came due: what it asks is under Crons below.");
    expect(prompt).toContain(
      `- "Check the deploy" (cron ${cron.id}), set by user at 2026-10-10T08:00:00.000Z, fires \`0 * * * *\` in the society's time zone, Asia/Shanghai. The turn of its previous fire failed at 2026-10-10T09:02:00.000Z. Next it fires at 2026-10-10T11:00:00.000Z.`,
    );
    expect(prompt).toContain("  Read the deploy log and post what changed.");
    expect(prompt).toContain(`- "Look again" (cron ${once.id}),`);
    expect(prompt).toContain(
      "fires once at 2026-10-10T10:00:00.000Z. The turn of its previous fire failed",
    );
    expect(prompt).toContain("It fired once, as set, and has ended.");
    // A turn no cron woke has no section for crons.
    expect(
      buildTurnPrompt({
        dispatch: { ...cronlessDispatch },
        messages: [],
        heldClaims: [],
        lastTurn: null,
        onboarding: null,
      }),
    ).not.toContain("## Crons");
  });

  it("names each cron whose latest fire's turn failed, with its note, in a section of its own after the previous turn's notice", () => {
    const once = {
      ...CronFrontmatterSchema.parse({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        title: "Look again",
        agent: "eng-1",
        scope: "demo",
        schedule: { at: "2026-10-10T10:00:00.000Z" },
        createdBy: "eng-1",
        createdAt: "2026-10-10T08:00:00.000Z",
        since: "2026-10-10T08:00:00.000Z",
        lastFiredAt: "2026-10-10T10:00:00.000Z",
        lastRun: {
          turnId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          at: "2026-10-10T10:03:00.000Z",
          outcome: "failed",
        },
        failures: 1,
        ended: { at: "2026-10-10T10:00:00.000Z", by: "board", reason: "fired once, as set" },
      }),
      note: "Is the fix live?",
    };
    const failed: TurnRecord = {
      agent: "eng-1",
      project: "demo",
      runner: "server",
      cli: "claude",
      session: "s",
      trigger: TriggerSchema.parse({ kind: "cron", reason: 'cron "Look again" came due' }),
      startedAt: "2026-10-10T10:00:00.000Z",
      endedAt: "2026-10-10T10:03:00.000Z",
      exitReason: "error",
      status: null,
      error: "the CLI ended",
      usage: null,
      costUsd: 0,
      toolCalls: 2,
      model: null,
      crons: [once.id],
    };
    const next = (lastTurn: TurnRecord | null, failedCrons: readonly (typeof once)[]) =>
      buildTurnPrompt({
        dispatch: cronlessDispatch,
        clock: { now: new Date("2026-10-10T10:20:00.000Z"), timeZone: "UTC" },
        messages: [],
        heldClaims: [],
        lastTurn,
        failedCrons,
        onboarding: null,
      });
    const worktree =
      "The worktree may hold uncommitted changes. Run git status before doing anything else.";
    const section = [
      "## Cron fires that did not finish",
      "",
      "The turn of this cron's latest fire here failed, so what its note asks may not be done:",
      "",
      `- "Look again" (cron ${once.id}), set by eng-1 at 2026-10-10T08:00:00.000Z, fires once at 2026-10-10T10:00:00.000Z. The turn of its previous fire failed at 2026-10-10T10:03:00.000Z. It fired once, as set, and has ended.`,
      "",
      "  Is the fix live?",
    ].join("\n");
    // The fire's own turn was the previous one: its notice as for any failed turn, then the cron.
    expect(next(failed, [once])).toContain(
      [
        "## Your previous turn did not finish",
        "",
        "It ended with error: the CLI ended.",
        worktree,
        "",
        section,
      ].join("\n"),
    );
    // A turn between that the user stopped, or none known, leaves the section as it is.
    expect(next({ ...failed, exitReason: "stopped", error: null }, [once])).toContain(section);
    expect(next(null, [once])).toContain(section);

    // Several: a recurring one with when it fires next, and one paused.
    const hourly = {
      ...once,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      title: "Check the deploy",
      schedule: { cron: "0 * * * *" },
      ended: undefined,
      note: "Read the deploy log.",
    };
    const paused = {
      ...hourly,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      title: "Check the queue",
      paused: { at: "2026-10-10T10:10:00.000Z", by: "user" },
    };
    const several = next({ ...failed, crons: [] }, [hourly, paused]);
    expect(several).toContain(
      "The turns of these crons' latest fires here failed, so what their notes ask may not be done:",
    );
    expect(several).toContain(
      `- "Check the deploy" (cron ${hourly.id}), set by eng-1 at 2026-10-10T08:00:00.000Z, fires \`0 * * * *\` in the society's time zone, UTC. The turn of its previous fire failed at 2026-10-10T10:03:00.000Z. Next it fires at 2026-10-10T11:00:00.000Z.\n\n  Read the deploy log.`,
    );
    expect(several).toContain(
      `(cron ${paused.id}), set by eng-1 at 2026-10-10T08:00:00.000Z, fires \`0 * * * *\` in the society's time zone, UTC. The turn of its previous fire failed at 2026-10-10T10:03:00.000Z. user has paused it since it fired, so it fires no more until resumed.`,
    );

    // With none, a failed turn's notice is as it was, and there is no section.
    expect(next(failed, [])).toContain(
      `## Your previous turn did not finish\n\nIt ended with error: the CLI ended.\n${worktree}`,
    );
    expect(next(failed, [])).not.toContain("## Cron fires that did not finish");
  });

  it("carries the trigger, held claims, unread messages with thread titles, and a failed-turn note", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "eng-1",
        project: "demo",
        trigger: TriggerSchema.parse({
          kind: "mention",
          from: "user",
          fromUser: true,
          reason: "mentioned by user",
        }),
        priority: 2,
        onboarding: false,
      },
      messages: [
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          author: "user",
          channel: "demo/general",
          ts: "2026-09-28T10:00:00.000Z",
          mentions: ["eng-1"],
          body: "@eng-1 please start on the scaffold",
        },
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          author: "rev-1",
          channel: "demo/dev",
          thread: "01ARZ3NDEKTSV4RRFFQ69G5FAT",
          ts: "2026-09-28T10:01:00.000Z",
          mentions: [],
          body: "vitest, I think",
        },
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          author: "rev-1",
          channel: "demo/general",
          thread: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          step: { action: "returned", stage: "s2", to: "s1" },
          ts: "2026-09-28T10:02:00.000Z",
          mentions: [],
          body: "Add a second line.",
        },
      ],
      threads: new Map([
        [
          "01ARZ3NDEKTSV4RRFFQ69G5FAT",
          {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAT",
            channel: "demo/dev",
            title: "Which runner?",
            state: "open",
            openedBy: "eng-1",
            openedAt: "2026-09-28T09:59:00.000Z",
            body: "",
          },
        ],
      ]),
      heldClaims: [],
      lastTurn: {
        agent: "eng-1",
        project: "demo",
        runner: "server",
        cli: "claude",
        session: "s",
        trigger: TriggerSchema.parse({ kind: "heartbeat" }),
        startedAt: "2026-09-28T09:00:00.000Z",
        endedAt: "2026-09-28T09:01:00.000Z",
        exitReason: "timeout",
        status: null,
        error: null,
        usage: null,
        costUsd: 0,
        toolCalls: 3,
        model: null,
      },
      onboarding: null,
    });
    expect(prompt).toContain("Trigger: mention from user. mentioned by user");
    expect(prompt).toContain("Your previous turn did not finish");
    expect(prompt).toContain("## Unread messages (3)");
    expect(prompt).toContain(
      'demo/dev thread "Which runner?" (01ARZ3NDEKTSV4RRFFQ69G5FAT) from @rev-1 (message',
    );
    // A task verb's note says what the step did.
    expect(prompt).toContain(
      "thread 01ARZ3NDEKTSV4RRFFQ69G5FAY from @rev-1, who sent the task back from s2 to s1 (message",
    );
    expect(prompt).toContain("please start on the scaffold");
    // A home turn names its conversation and carries no stages: those are their tasks' business.
    expect(prompt).toContain("This turn is in your home conversation for demo");
    expect(prompt).not.toContain("Stages you hold");
    expect(prompt).not.toContain("Stages waiting for you");
    expect(prompt).not.toContain("First turn");
  });

  it("adds the onboarding preamble on a first turn", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "eng-1",
        project: "demo",
        trigger: TriggerSchema.parse({ kind: "onboarding", reason: "joined" }),
        priority: 1,
        onboarding: true,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: {
        agentName: "eng-1",
        roleSummary: "Builds things.",
        project: "demo",
        worktree: "/tmp/wt",
        memoryWritten: false,
        profileWritten: false,
      },
    });
    expect(prompt).toContain("This is your first turn as eng-1");
    expect(prompt).toContain("Nothing new.");
  });

  it("carries changed instructions whole, once, marked as replacing the earlier ones, and nothing otherwise", () => {
    const instructions = "# eng-1\n\n## Role\n\n# engineer\n\n## Core memory\n\n- A new lesson.\n";
    const changed = promptWith(instructions);
    expect(changed.split("## Your instructions changed").length - 1).toBe(1);
    expect(changed).toContain(
      "Between the tags below are the whole of them now: they replace the instructions this conversation began with and any earlier text like this, so where the two differ, follow these, and a rule missing from them no longer applies.",
    );
    expect(changed).toContain(`<instructions>\n${instructions.trimEnd()}\n</instructions>\n`);
    // Before the conversation, so the turn reads its rules before its work.
    expect(changed.indexOf("</instructions>")).toBeLessThan(
      changed.indexOf("## This conversation"),
    );
    for (const unchanged of [promptWith(), promptWith(null)]) {
      expect(unchanged).not.toContain("## Your instructions changed");
      expect(unchanged).not.toContain("<instructions>");
    }
  });

  it("says a dropped session's turn starts anew, and why, and says nothing of it otherwise", () => {
    const words = "Claude Code returned an error result: No conversation found with session ID: s";
    const failed = {
      agent: "eng-1",
      project: "demo",
      runner: "server",
      cli: "claude" as const,
      session: "s",
      trigger: TriggerSchema.parse({ kind: "heartbeat" }),
      startedAt: "2026-09-28T09:00:00.000Z",
      endedAt: "2026-09-28T09:00:01.000Z",
      exitReason: "error" as const,
      status: null,
      error: words,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: null,
      resumeFailed: "lost" as const,
    };
    const prompt = (lastTurn: typeof failed & { sessionDropped?: boolean }) =>
      buildTurnPrompt({
        dispatch: cronlessDispatch,
        messages: [],
        heldClaims: [],
        lastTurn,
        onboarding: null,
      });
    const note =
      "Its CLI could not resume this conversation's session, so the session was dropped and this turn starts a new one: nothing of your earlier turns here carries over but what is on the board and in your home.";
    const dropped = prompt({ ...failed, sessionDropped: true });
    expect(dropped).toContain(`It ended with error: ${words}.\n${note}\n`);
    expect(prompt(failed)).toContain(`It ended with error: ${words}.\nThe worktree`);
    expect(prompt(failed)).not.toContain(note);
  });

  it("gives the front desk the roster and the project list, and frames a user post as routing", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "desk",
        project: "society",
        trigger: TriggerSchema.parse({
          kind: "user_post",
          from: "user",
          fromUser: true,
          reason: "the user posted in general",
        }),
        priority: 2,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      societyView: {
        projects: [
          {
            slug: "demo",
            name: "Demo",
            repo: null,
            defaultBranch: "main",
            channels: ["general", "dev"],
            archivedChannels: [],
            members: ["eng-1"],
            approvers: ["user"],
            requiredCapabilities: [],
            createdAt: "2026-09-28T10:00:00.000Z",
            onDone: "merge",
          },
        ],
        members: [
          {
            name: "eng-1",
            role: "engineer",
            cli: "codex",
            homeRunner: "server",
            status: "active",
            resident: false,
            skills: ["uv-setup"],
            memberships: ["demo"],
            subscriptions: ["general", "demo/general"],
            lastModel: "gpt-5-codex",
            claimsHeld: 1,
            tasksDone: 3,
            lastTurnAt: "2026-09-28T11:00:00.000Z",
            lastTurnOutcome: "mention on demo: completed, shipped the endpoint",
            createdAt: "2026-09-28T10:00:00.000Z",
            profile: "# Profile\n\nBackend work in Python; send me API tasks.\n",
          },
        ],
      },
    });
    expect(prompt).toContain("Trigger: user_post from user. the user posted in general");
    expect(prompt).toContain(
      "Route it: answer where it was posted, in its thread when it came in one",
    );
    expect(prompt).toContain("## The society");
    // Asks run side by side, so the front desk looks for proposals another ask already made.
    expect(prompt).toContain(
      "look at the proposals still waiting under {{stellaris:board}}/society/proposals/",
    );
    expect(prompt).toContain('- demo "Demo": channels general, dev; members eng-1; on done merge');
    expect(prompt).toContain(
      "- eng-1: engineer on codex (gpt-5-codex); active; projects demo; follows general, demo/general; skills uv-setup; 1 claim(s) held; 3 done; last turn 2026-09-28T11:00:00.000Z mention on demo: completed, shipped the endpoint. Profile: Backend work in Python; send me API tasks.",
    );
  });

  it("gives a task's conversation its task, and the stage held or waiting with the rest of its plan", () => {
    const ts = "2026-09-29T10:00:00.000Z";
    const task = (id: string, title: string, stage: string, claimedBy?: string) => ({
      ...TaskFrontmatterSchema.parse({
        id,
        project: "lab",
        title,
        status: claimedBy === undefined ? "open" : "claimed",
        createdBy: "desk",
        createdAt: ts,
        updatedAt: ts,
        ...(claimedBy === undefined ? {} : { claimedBy, leaseExpiresAt: ts }),
        blockedBy: [],
        requiredCapabilities: [],
        stages: [
          { id: "s1", name: "experiment", role: "researcher" },
          { id: "s2", name: "write-up", role: "researcher" },
          { id: "s3", name: "referee review", role: "editor", gate: true },
        ],
        stage,
        stageSince: ts,
        stageSeq: 3,
        onDone: "merge",
      }),
      body: "",
    });
    const project = {
      slug: "lab",
      name: "Lab",
      repo: null,
      defaultBranch: "main",
      channels: ["general"],
      archivedChannels: [],
      members: ["res-1"],
      approvers: ["user"],
      requiredCapabilities: [],
      createdAt: ts,
      onDone: "merge" as const,
    };
    const threadOf = (id: string, title: string) => ({
      id,
      channel: "lab/general",
      title,
      subject: { kind: "task" as const, id },
      state: "open" as const,
      openedBy: "desk",
      openedAt: ts,
      body: "",
    });
    const churn = task("01ARZ3NDEKTSV4RRFFQ69G5FAV", "Churn model", "s1");
    const waiting = buildTurnPrompt({
      dispatch: {
        agent: "res-1",
        project: "lab",
        thread: { id: churn.id, task: true },
        trigger: TriggerSchema.parse({
          kind: "stage",
          from: "desk",
          reason:
            'stage "experiment" of task 01ARZ3NDEKTSV4RRFFQ69G5FAV "Churn model" is waiting for you',
          taskId: churn.id,
        }),
        priority: 1,
        onboarding: false,
      },
      messages: [],
      conversation: { thread: threadOf(churn.id, churn.title), task: churn, fresh: true },
      heldClaims: [],
      waitingStages: [churn],
      project,
      lastTurn: null,
      onboarding: null,
    });
    expect(waiting).toContain("A stage is waiting for you: claim it with claim_task");
    expect(waiting).toContain(
      "Never merge or fast-forward main yourself, or push other work to it on the remote; the runner refuses both.",
    );
    expect(waiting).toContain(
      `This turn is in the thread "Churn model" on lab/general, about task ${churn.id}.`,
    );
    expect(waiting).toContain(
      '## Stages waiting for you\n\n- 01ARZ3NDEKTSV4RRFFQ69G5FAV "Churn model": experiment (open to researcher, 1 of 3); next: write-up (researcher), referee review (gate, editor)',
    );
    expect(waiting).toContain("## Stages you hold\n\nNone.");
    // A new conversation is shown its thread so far, not only what is unread.
    expect(waiting).toContain("## The thread so far (0)");

    // A task a planner set to land through its pull request is told so, whatever its project does.
    const viaPull = { ...churn, onDone: "ghpr" as const };
    const pulled = buildTurnPrompt({
      dispatch: {
        agent: "res-1",
        project: "lab",
        thread: { id: churn.id, task: true },
        trigger: TriggerSchema.parse({ kind: "manual", fromUser: true, reason: "test" }),
        priority: 1,
        onboarding: false,
      },
      messages: [],
      conversation: { thread: threadOf(churn.id, churn.title), task: viaPull, fresh: true },
      heldClaims: [],
      waitingStages: [viaPull],
      project,
      lastTurn: null,
      onboarding: null,
    });
    expect(pulled).toContain(
      "A finished task lands by the board merging its pull request on GitHub into main.",
    );
    expect(pulled).toContain("link it to the task with update_task pull_request");
    expect(pulled).not.toContain("merging its branch task/<id>");

    const pricing = task("01ARZ3NDEKTSV4RRFFQ69G5FAW", "Pricing", "s2", "res-1");
    const held = buildTurnPrompt({
      dispatch: {
        agent: "res-1",
        project: "lab",
        thread: { id: pricing.id, task: true },
        trigger: TriggerSchema.parse({ kind: "heartbeat", reason: "heartbeat" }),
        priority: 0,
        onboarding: false,
      },
      messages: [],
      conversation: { thread: threadOf(pricing.id, pricing.title), task: pricing, fresh: false },
      heldClaims: [pricing],
      project,
      lastTurn: null,
      onboarding: null,
    });
    expect(held).toContain(
      '- 01ARZ3NDEKTSV4RRFFQ69G5FAW "Pricing": write-up (yours, 2 of 3); next: referee review (gate, editor); lease until 2026-09-29T10:00:00.000Z',
    );
    expect(held).toContain("## Unread messages (0)");

    // A wake queued before the thread closed still runs; its turn is told where to post instead.
    const late = buildTurnPrompt({
      dispatch: {
        agent: "res-1",
        project: "lab",
        thread: { id: pricing.id, task: true },
        trigger: TriggerSchema.parse({
          kind: "mention",
          from: "desk",
          reason: "mentioned by desk",
        }),
        priority: 1,
        onboarding: false,
      },
      messages: [],
      conversation: {
        thread: { ...threadOf(pricing.id, pricing.title), state: "closed" },
        task: { ...pricing, status: "abandoned" },
        fresh: false,
        replyIn: "lab/general",
      },
      heldClaims: [],
      project,
      lastTurn: null,
      onboarding: null,
    });
    expect(late).toContain(
      "This thread is closed, so posts to it are refused: if something still needs saying, post it in lab/general.",
    );
    expect(late).not.toContain(`Talk here with post_message and thread_id ${pricing.id}.`);
  });

  it("names every task done that merged into the wake, whichever trigger it kept", () => {
    const [first, second] = ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAW"];
    const done = { kind: "task_done", from: "rev-1", taskId: first };

    const one = donePrompt({ ...done, reason: `task ${first} you created is done` }, [first]);
    expect(one).toContain(`Trigger: task_done from rev-1. task ${first} you created is done`);
    expect(one).toContain(`Task in question: ${first}`);
    expect(one).toContain("A task you created is done. Tell whoever asked for it, if anyone did.");

    const both = donePrompt({ ...done, reason: `tasks ${first}, ${second} you created are done` }, [
      first,
      second,
    ]);
    expect(both).toContain(
      `Trigger: task_done from rev-1. tasks ${first}, ${second} you created are done`,
    );
    expect(both).toContain(`Tasks in question: ${first}, ${second}`);
    expect(both).toContain(
      `Tasks you created are done: ${first}, ${second}. Tell whoever asked for each, if anyone did.`,
    );
    expect(both).not.toContain("A task you created is done");

    const mention = { kind: "mention", from: "user", fromUser: true, reason: "mentioned by user" };
    const under = donePrompt(mention, [first]);
    expect(under).toContain("Trigger: mention from user. mentioned by user");
    expect(under).not.toContain("in question");
    expect(under).toContain(
      `A task you created is done too: ${first}. Tell whoever asked for it, if anyone did.`,
    );
    expect(donePrompt(mention, [first, second])).toContain(
      `Tasks you created are done: ${first}, ${second}. Tell whoever asked for each, if anyone did.`,
    );
    expect(donePrompt(mention)).not.toContain("you created");
  });

  it("points at every proposal decided that merged into the wake, whichever trigger it kept", () => {
    const [first, second] = ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAW"];
    const rest =
      "A decision wakes you in the conversation you filed the proposal from, or at home once that has ended.";
    const decided = {
      kind: "proposal_decided",
      from: "user",
      fromUser: true,
      proposalId: first,
      reason: `your channel proposal ${first} was approved by user`,
    };

    // One decision reads as before the board carried them, which a wake it queued then has none of.
    for (const one of [decidedPrompt(decided, [first]), decidedPrompt(decided)]) {
      expect(one).toContain(
        `A proposal you made was decided; the decision is the last post in the proposal's thread. ${rest}`,
      );
    }

    const both = decidedPrompt(
      {
        ...decided,
        reason: `your channel proposal ${first} was approved by user; your channel proposal ${second} was rejected by user`,
      },
      [first, second],
    );
    expect(both).toContain(
      `Trigger: proposal_decided from user. your channel proposal ${first} was approved by user; your channel proposal ${second} was rejected by user`,
    );
    expect(both).toContain(
      `Proposals you made were decided: ${first}, ${second}; each decision is the last post in that proposal's thread. ${rest}`,
    );
    expect(both).not.toContain("A proposal you made");

    const mention = { kind: "mention", from: "user", fromUser: true, reason: "mentioned by user" };
    expect(decidedPrompt(mention, [first])).toContain(
      `A proposal you made was decided too: ${first}; the decision is the last post in its thread. ${rest}`,
    );
    expect(decidedPrompt(mention, [first, second])).toContain(
      `Proposals you made were decided: ${first}, ${second};`,
    );
    expect(decidedPrompt(mention)).not.toContain("you made");
  });

  it("frames a turn triggered by operations signals as a decision about proposing", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "stew-1",
        project: "demo",
        trigger: TriggerSchema.parse({
          kind: "ops_event",
          from: "board",
          reason: "demo: 4 open or claimed task(s) for 1 engineer(s)",
        }),
        priority: 0,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      signals: [
        {
          ts: "2026-09-30T06:00:00.000Z",
          signal: {
            kind: "backlog",
            key: "backlog:demo:engineer",
            summary: "demo: 4 open or claimed task(s) for 1 engineer(s)",
            value: 4,
            threshold: 3,
            project: "demo",
          },
        },
      ],
    });
    expect(prompt).toContain("Trigger: ops_event from board. demo: 4 open");
    expect(prompt).toContain(
      "Operations signals arrived; they are listed under Operations signals",
    );
    expect(prompt).toContain("propose");
    // The signals themselves are in the prompt, not in a channel's posts.
    expect(prompt).toContain(
      "- [2026-09-30T06:00:00.000Z] backlog: demo: 4 open or claimed task(s) for 1 engineer(s) (value 4, threshold 3; project demo)",
    );
    const none = buildTurnPrompt({
      dispatch: {
        agent: "stew-1",
        project: "demo",
        trigger: TriggerSchema.parse({ kind: "heartbeat" }),
        priority: 0,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      signals: [],
    });
    expect(none).toContain("## Operations signals\n\nNone since your last turn here.");
    // Roles that read no signals get no section at all.
    const reader = buildTurnPrompt({
      dispatch: {
        agent: "eng-1",
        project: "demo",
        trigger: TriggerSchema.parse({ kind: "heartbeat" }),
        priority: 0,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
    });
    expect(reader).not.toContain("## Operations signals");
  });

  it("tells a proposer woken by a decision to drop its own copy of a skill once it is published", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "eng-2",
        project: "society",
        trigger: TriggerSchema.parse({
          kind: "proposal_decided",
          from: "stew",
          reason: "proposal approved by stew",
        }),
        priority: 0,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
    });
    expect(prompt).toContain("A proposal you made was decided");
    expect(prompt).toContain(
      "An approved skill is published under society/skills/<name>/: delete your own skills/<name>/ from your home and report memoryUpdated",
    );
  });

  it("shows a society role every runner, what it offers, and the projects living on it", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "desk",
        project: "society",
        trigger: TriggerSchema.parse({ kind: "user_post", fromUser: true }),
        priority: 2,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      societyView: { projects: [listedProject("lab", "pod"), listedProject("new")], members: [] },
      runners: {
        runners: [
          {
            name: "pod",
            os: "linux",
            clis: ["claude", "codex"],
            capabilities: [],
            status: "connected",
          },
          {
            name: "laptop",
            os: "darwin",
            clis: ["claude"],
            capabilities: ["gpu", "xcode"],
            status: "disconnected",
            lastSeen: "2026-10-01T09:00:00.000Z",
          },
          {
            name: "merlin",
            os: "linux",
            clis: ["claude", "codex"],
            capabilities: [],
            status: "connected",
            quotas: {
              codex: CliQuotaSchema.parse({
                observedAt: "2026-10-13T11:00:00.000Z",
                source: "turn",
                status: "limited",
                limitedUntil: "2026-10-20T05:11:58.000Z",
              }),
              claude: CliQuotaSchema.parse({
                observedAt: "2026-10-13T11:30:00.000Z",
                source: "turn",
                status: "allowed",
                windows: [
                  {
                    key: "five_hour",
                    minutes: 300,
                    usedPercent: 84.6,
                    resetsAt: "2026-10-13T14:00:00.000Z",
                    observedAt: "2026-10-13T11:30:00.000Z",
                  },
                  {
                    key: "seven_day",
                    minutes: 10_080,
                    usedPercent: 12,
                    resetsAt: "2026-10-13T11:45:00.000Z",
                    observedAt: "2026-10-13T11:30:00.000Z",
                  },
                ],
              }),
            },
          },
        ],
        projects: [listedProject("lab", "pod"), listedProject("new")],
      },
      clock: { now: new Date("2026-10-13T12:00:00.000Z"), timeZone: "UTC" },
    });
    expect(prompt).toContain("## Runners");
    expect(prompt).toContain(
      "required_capabilities must name capabilities exactly as a runner below offers them",
    );
    expect(prompt).toContain(
      "- pod: connected; linux; CLIs claude, codex; offers nothing beyond its CLIs; projects lab",
    );
    expect(prompt).toContain(
      "- laptop: away since 2026-10-01T09:00:00.000Z; darwin; CLIs claude; offers gpu, xcode; no projects",
    );
    // Each CLI's quota in the order the runner lists its CLIs; a window reset since reads so, and a
    // limit holds its CLI's turns until its reset.
    expect(prompt).toContain(
      "- merlin: connected; linux; CLIs claude, codex; offers nothing beyond its CLIs; no projects; codex held by its limit until 2026-10-20T05:11:58.000Z; quota claude 5h 84%, 7d reset since (near a limit) as of 2026-10-13T11:30:00.000Z; codex limited until 2026-10-20T05:11:58.000Z",
    );
    // The front desk's project list says where each project lives.
    expect(prompt).toContain("on done none; on runner pod");
    expect(prompt).toContain("on done none; not placed on a runner yet");
  });

  it("says which runners, and which CLIs on one, the user paused, beside the quota", () => {
    const pause = { at: "2026-10-13T08:00:00.000Z", by: "user" };
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "eng-1",
        project: "society",
        trigger: TriggerSchema.parse({ kind: "user_post", fromUser: true }),
        priority: 2,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      runners: {
        runners: [
          {
            name: "pod",
            os: "linux",
            clis: ["claude", "codex"],
            capabilities: [],
            status: "connected",
            paused: pause,
          },
          {
            name: "merlin",
            os: "linux",
            clis: ["claude", "codex"],
            capabilities: [],
            status: "connected",
            pausedClis: { claude: pause },
            quotas: {
              claude: CliQuotaSchema.parse({
                observedAt: "2026-10-13T11:00:00.000Z",
                source: "turn",
                status: "limited",
                limitedUntil: "2026-10-20T05:11:58.000Z",
              }),
            },
          },
          {
            name: "ca",
            os: "linux",
            clis: ["antigravity"],
            capabilities: [],
            status: "connected",
            quotas: {
              antigravity: CliQuotaSchema.parse({
                observedAt: "2026-10-13T11:50:00.000Z",
                source: "turn",
                status: "warning",
                pools: [
                  {
                    key: "3p",
                    label: "Claude and GPT models",
                    limited: true,
                    limitedUntil: "2026-10-13T15:40:00.000Z",
                    observedAt: "2026-10-13T11:50:00.000Z",
                  },
                ],
              }),
            },
          },
        ],
        projects: [listedProject("lab", "pod")],
      },
      clock: { now: new Date("2026-10-13T12:00:00.000Z"), timeZone: "UTC" },
    });
    expect(prompt).toContain(
      "- pod: connected, paused by the user since 2026-10-13T08:00:00.000Z; linux; CLIs claude, codex; offers nothing beyond its CLIs; projects lab\n",
    );
    expect(prompt).toContain(
      "- merlin: connected; linux; CLIs claude, codex; offers nothing beyond its CLIs; no projects; claude paused by the user since 2026-10-13T08:00:00.000Z; claude held by its limit until 2026-10-20T05:11:58.000Z; quota claude limited until 2026-10-20T05:11:58.000Z\n",
    );
    expect(prompt).toContain(
      "- ca: connected; linux; CLIs antigravity; offers nothing beyond its CLIs; no projects; antigravity's Claude and GPT models (pool 3p) held by their limit until 2026-10-13T15:40:00.000Z;",
    );
    expect(prompt).toContain(
      "A runner, or a CLI on it, paused by the user starts none of the turns it would run until the user resumes it, and a CLI held by its limit starts none of its turns there until the limit lifts, nor a CLI's pool of models held by its own limit any turn of a citizen whose model is in it",
    );
    expect(prompt).toContain(
      "and a runner syncing its board copy as it connects starts none until the copy is up to date: they wait, and the stages their citizens hold keep their leases.",
    );
  });

  it("names a runner syncing its board copy in the Runners section, with how far it has come and its last failure", () => {
    const sync = {
      phase: "copying" as const,
      files: 6_200,
      totalFiles: 15_152,
      bytes: 11_000_000,
      totalBytes: 27_000_000,
      attempt: 1,
      startedAt: "2026-10-13T11:58:00.000Z",
      updatedAt: "2026-10-13T11:59:59.000Z",
    };
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "eng-1",
        project: "society",
        trigger: TriggerSchema.parse({ kind: "user_post", fromUser: true }),
        priority: 2,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      runners: {
        runners: [
          {
            name: "pod",
            os: "linux",
            clis: ["claude"],
            capabilities: [],
            status: "connected",
            sync,
          },
          {
            name: "far",
            os: "linux",
            clis: ["claude"],
            capabilities: [],
            status: "connected",
            sync: {
              ...sync,
              attempt: 3,
              error: "fetch failed, caused by SocketError: other side closed",
              nextTryAt: "2026-10-13T12:00:20.000Z",
            },
          },
          {
            name: "done",
            os: "linux",
            clis: ["claude"],
            capabilities: [],
            status: "connected",
            sync: { ...sync, phase: "done", finishedAt: "2026-10-13T11:59:00.000Z" },
          },
        ],
        projects: [listedProject("lab", "pod")],
      },
      clock: { now: new Date("2026-10-13T12:00:00.000Z"), timeZone: "UTC" },
    });
    expect(prompt).toContain(
      "- pod: connected, syncing its board copy since 2026-10-13T11:58:00.000Z (6,200 / 15,152 files); linux;",
    );
    expect(prompt).toContain(
      "- far: connected, syncing its board copy since 2026-10-13T11:58:00.000Z (6,200 / 15,152 files), try 3 failed (fetch failed, caused by SocketError: other side closed), next at 2026-10-13T12:00:20.000Z; linux;",
    );
    expect(prompt).toContain("- done: connected; linux;");
  });

  it("tells a turn outside projects when it was asked from a project the citizen is not in", () => {
    const base = { messages: [], heldClaims: [], lastTurn: null, onboarding: null };
    const asked = (channel: string, project = "society"): string =>
      buildTurnPrompt({
        ...base,
        dispatch: {
          agent: "eng-1",
          project,
          trigger: TriggerSchema.parse({ kind: "mention", from: "user", channel }),
          priority: 2,
          onboarding: false,
        },
      });
    expect(asked("lab/general")).toContain(
      "You were asked in lab/general, in project lab, which you are not a member of",
    );
    expect(asked("lab/general")).toContain("join it with join_project");
    // Asked in a society channel, or in its own project, there is nothing to explain.
    expect(asked("general")).not.toContain("You were asked in");
    expect(asked("lab/general", "lab")).not.toContain("You were asked in");
  });

  it("frames a reflection turn as memory work and lists the scope's knowledge topics", () => {
    const dispatch = {
      agent: "eng-1",
      project: "demo",
      trigger: TriggerSchema.parse({ kind: "reflection", reason: "scheduled reflection" }),
      priority: 0,
      onboarding: false,
    };
    const empty = buildTurnPrompt({
      dispatch,
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      knowledge: { dir: "/data/board/projects/demo/knowledge", topics: [] },
    });
    expect(empty).toContain("## Reflection");
    expect(empty).toContain("take no new work");
    expect(empty).toContain("skills/<name>/SKILL.md");
    expect(empty).toContain("memoryUpdated: true");
    expect(empty).toContain("## Knowledge of demo\n\nNone yet.");
    // A repeated procedure is a candidate for a skill, proposed only when others would use it.
    expect(empty).toContain("followed twice is a candidate");
    expect(empty).toContain(
      "more than one citizen would use it and nothing in it is tied to one place",
    );
    // How a codebase behaves goes in its own documents, not in project knowledge.
    expect(empty).toContain(
      "Share: how a codebase behaves goes in its AGENTS.md or README through a task like any change to the code, so propose it in that task's thread or the project channel",
    );
    // The project channel wakes only whom a post asks, so the proposal names who acts on it.
    expect(empty).toContain(
      "propose it in that task's thread or the project channel, mentioning whoever is to act on it;",
    );
    expect(empty).toContain(
      "a durable fact about this scope as a place (runners, access, flow, where results live) goes through write_knowledge",
    );
    expect(empty).toContain("A durable fact about this place, such as its runners");

    const listed = buildTurnPrompt({
      dispatch: { ...dispatch, trigger: TriggerSchema.parse({ kind: "heartbeat" }) },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      knowledge: {
        dir: "/data/board/projects/demo/knowledge",
        topics: [
          {
            topic: "testing",
            project: "demo",
            revision: 2,
            updatedBy: "eng-1",
            updatedAt: "2026-09-28T10:00:00.000Z",
            body: "Run the tests with uv.",
          },
        ],
      },
    });
    expect(listed).not.toContain("## Reflection");
    expect(listed).toContain("Topics under /data/board/projects/demo/knowledge");
    expect(listed).toContain("- testing: revision 2, updated by eng-1 at 2026-09-28T10:00:00.000Z");
    expect(listed).not.toContain("Run the tests with uv.");
  });

  it("tells a reflection whose session ends with it to write down what is open, and the next turn that it started afresh", () => {
    const reflection = TriggerSchema.parse({ kind: "reflection", reason: "scheduled reflection" });
    const dispatch = {
      agent: "steward-1",
      project: "society",
      trigger: reflection,
      priority: 0,
      onboarding: false,
    };
    const base = { dispatch, messages: [], heldClaims: [], lastTurn: null, onboarding: null };
    const save =
      "- This conversation's session ends with this turn, and the next turn here starts a new one that knows only your home's files and the board: write anything still open into memory/core.md, or the archive it points to, before you end.";
    const ending = buildTurnPrompt({ ...base, afreshAfterReflection: true });
    expect(ending).toContain(
      `${save}\n- Report memoryUpdated: true in the status object when core.md or a skill changed.`,
    );
    expect(buildTurnPrompt(base)).not.toContain(save);
    expect(buildTurnPrompt(base)).toContain("- Report memoryUpdated: true");
    // Any other turn of such a home is told nothing of it.
    const heartbeat = { ...dispatch, trigger: TriggerSchema.parse({ kind: "heartbeat" }) };
    expect(
      buildTurnPrompt({ ...base, dispatch: heartbeat, afreshAfterReflection: true }),
    ).not.toContain("session ends with this turn");

    const reflected = {
      agent: "steward-1",
      project: "society",
      runner: "server",
      cli: "claude" as const,
      session: "s",
      trigger: reflection,
      startedAt: "2026-09-28T09:00:00.000Z",
      endedAt: "2026-09-28T09:05:00.000Z",
      exitReason: "completed" as const,
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: null,
    };
    // The home's session record after the reflection: the session went with it, or stayed.
    const dropped = { runner: "server" };
    const kept = { claude: "s", runner: "server" };
    const after = (lastTurn: TurnRecord, sessions: typeof dropped) =>
      buildTurnPrompt({
        ...base,
        dispatch: heartbeat,
        lastTurn,
        afresh: sessionAfresh(sessions, lastTurn, "claude", "server"),
      });
    const note =
      "## Your session started afresh\n\nYour last turn here was a reflection, and this conversation's session ended with it, so this turn starts a new one: what you kept is in memory/core.md and the archive it points to, and what your earlier turns did is on the board, in your posts and the threads and tasks you worked in, which search and the board's files reach.";
    expect(after({ ...reflected, sessionDropped: true }, dropped)).toContain(note);
    // A reflection that kept its session, or failed, says nothing of a new one.
    expect(after(reflected, kept)).not.toContain("## Your session started afresh");
    const timedOut = { ...reflected, exitReason: "timeout" as const, error: "turn timed out" };
    expect(after(timedOut, kept)).not.toContain("## Your session started afresh");
    expect(after(timedOut, kept)).toContain("## Your previous turn did not finish");
  });

  it("names a failure that was not the citizen's in a fixed line, and keeps the words of one that may be", () => {
    const dispatch = {
      agent: "eng-1",
      project: "society",
      trigger: TriggerSchema.parse({ kind: "manual", reason: "work" }),
      priority: 1,
      onboarding: false,
    };
    const after = (lastTurn: TurnRecord) =>
      buildTurnPrompt({ dispatch, messages: [], heldClaims: [], lastTurn, onboarding: null });
    // Failures outside the citizen's work, in the words the live board logged: the line names the
    // cause, and the error's own words stay on the turn record.
    const notYours: ReadonlyArray<readonly [string, string]> = [
      [
        "usage limit reached: You've hit your 5-hour limit · resets 9:20pm (UTC)",
        "your CLI's usage limit",
      ],
      [
        "API Error: Your account can't receive replies from Claude right now. You can find the next step in the Anthropic Verification Portal: https://portal.anthropic.com/verify?org=01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "a problem with your CLI's sign-in or account",
      ],
      [
        "Claude Code can't use your Claude subscription, usually because a payment is past due · Pay or renew at https://claude.ai/settings/billing (if you just paid, try again shortly), or use an Anthropic API key instead",
        "a problem with your CLI's sign-in or account",
      ],
      ["Not logged in · Please run /login", "a problem with your CLI's sign-in or account"],
      ["API Error: 529 Overloaded", "the model service turning a request away or cutting it off"],
      [
        "the runner could not run the turn: TypeError: fetch failed, caused by SocketError: other side closed (UND_ERR_SOCKET)",
        "your runner losing its connection to the board",
      ],
      ["runner pod went away during the turn", "your runner going away"],
      ["unrecognized_model: the model is not available", "a model your CLI does not know"],
    ];
    for (const [error, cause] of notYours) {
      const prompt = after(turn({ exitReason: "error", error }));
      expect(prompt).toContain(cutOff(cause));
      expect(prompt).not.toContain(error);
    }
    // What may be the citizen's to act on keeps its words: a timeout, a turn or context limit, a
    // missing status object, a session its CLI could not resume, and anything unrecognised.
    const maybeYours: ReadonlyArray<readonly [TurnRecord["exitReason"], string]> = [
      ["timeout", "turn exceeded 3600000 ms"],
      ["error", "turn limit reached: 200 turns"],
      ["error", "the turn ended without a parsable status object"],
      ["error", "Prompt is too long"],
      ["error", "No conversation found with session ID: s-1"],
      ["error", "the CLI ended"],
    ];
    for (const [exitReason, error] of maybeYours) {
      expect(after(turn({ exitReason, error }))).toContain(
        notice(`It ended with ${exitReason}: ${error}.`),
      );
    }
  });

  it("tells a home's new session after earlier ones why it is new, and its first turn nothing of it", () => {
    const done = turn({});
    const lost = turn({
      exitReason: "error",
      error: "No conversation found with session ID: s-1",
      resumeFailed: "lost",
      sessionDropped: true,
    });
    const reflected = turn({
      trigger: TriggerSchema.parse({ kind: "reflection", reason: "scheduled reflection" }),
      sessionDropped: true,
    });
    // A reflection whose resume failed lost its session to the resume, not to the reflection.
    const reflectionLost = { ...lost, trigger: reflected.trigger };
    const stoppedFirst = turn({ session: null, exitReason: "stopped" });
    const onPod = { claude: "s-1", runner: "pod" };

    // Which reason each record gives, or none.
    expect(sessionAfresh({}, null, "claude", "pod")).toBeNull();
    // A first turn that ended before its CLI started left no session, so the next is still first.
    expect(sessionAfresh({}, stoppedFirst, "claude", "pod")).toBeNull();
    expect(sessionAfresh(onPod, done, "claude", "pod")).toBeNull();
    expect(sessionAfresh(onPod, done, "claude", "far")).toEqual({
      reason: "runner",
      began: "pod",
      runs: "far",
    });
    expect(sessionAfresh({ runner: "pod" }, lost, "claude", "pod")).toEqual({ reason: "resume" });
    // The session was dropped wherever the turn now runs.
    expect(sessionAfresh({ runner: "pod" }, lost, "claude", "far")).toEqual({ reason: "resume" });
    expect(sessionAfresh({ runner: "pod" }, reflected, "claude", "far")).toEqual({
      reason: "reflection",
    });
    expect(sessionAfresh({ runner: "pod" }, reflectionLost, "claude", "pod")).toEqual({
      reason: "resume",
    });
    // A turn after the drop that ended before its CLI started left none either.
    expect(sessionAfresh({ runner: "pod" }, stoppedFirst, "claude", "pod")).toEqual({
      reason: "unkept",
    });
    // A switch of the citizen's CLI since its last turn here, which dropped every session it kept,
    // whatever ended the last turn; a session the old CLI's turn kept after it stays that CLI's.
    for (const last of [done, reflected, stoppedFirst]) {
      expect(sessionAfresh({ runner: "pod" }, last, "codex", "pod")).toEqual({
        reason: "cli",
        was: "claude",
        runs: "codex",
      });
    }
    expect(sessionAfresh(onPod, done, "codex", "pod")).toEqual({
      reason: "cli",
      was: "claude",
      runs: "codex",
    });
    expect(sessionAfresh({ codex: "c-1", runner: "pod" }, done, "codex", "pod")).toBeNull();

    const dispatch = {
      agent: "eng-1",
      project: "society",
      trigger: TriggerSchema.parse({ kind: "manual", reason: "work" }),
      priority: 1,
      onboarding: false,
    };
    const prompt = (lastTurn: TurnRecord, afresh: ReturnType<typeof sessionAfresh>) =>
      buildTurnPrompt({
        dispatch,
        messages: [],
        heldClaims: [],
        lastTurn,
        onboarding: null,
        afresh,
      });
    const kept =
      "so this turn starts a new one: what you kept is in memory/core.md and the archive it points to, and what your earlier turns did is on the board, in your posts and the threads and tasks you worked in, which search and the board's files reach.";
    expect(prompt(done, { reason: "runner", began: "pod", runs: "far" })).toContain(
      `## Your session started afresh\n\nThis conversation's session began on runner pod and stays there, and this turn runs on far, ${kept}`,
    );
    expect(prompt(done, { reason: "cli", was: "claude", runs: "codex" })).toContain(
      `## Your session started afresh\n\nYour CLI was switched from claude to codex since your last turn here, and a session stays with the CLI it began on, ${kept}`,
    );
    expect(prompt(stoppedFirst, { reason: "unkept" })).toContain(
      `## Your session started afresh\n\nNone of your earlier turns here left a session to resume, ${kept}`,
    );
    // A lost resume is told once, under the new session, beside the failure it caused.
    const resumed = prompt(lost, { reason: "resume" });
    expect(resumed).toContain(
      `## Your session started afresh\n\nYour last turn here failed because its CLI could not resume this conversation's session, which was dropped, ${kept}`,
    );
    expect(resumed).toContain(
      "## Your previous turn did not finish\n\nIt ended with error: No conversation found with session ID: s-1.\nThe worktree may hold",
    );
    expect(resumed.split("could not resume").length - 1).toBe(1);
    // A thread's new session has no such section, so its failure says why.
    const inThread = prompt(lost, null);
    expect(inThread).not.toContain("## Your session started afresh");
    expect(inThread).toContain(
      "Its CLI could not resume this conversation's session, so the session was dropped and this turn starts a new one",
    );
    expect(prompt(done, null)).not.toContain("## Your session started afresh");
  });

  it("shows a home's new session the posts read there before it, above its unread ones, and no heading for none", () => {
    const unread = generalPost("01ARZ3NDEKTSV4RRFFQ69G5FAZ", "@eng-1 the date?");
    const base = {
      dispatch: cronlessDispatch,
      messages: [unread],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
    };
    const long = `${"word ".repeat(80)}end`;
    const prompt = buildTurnPrompt({
      ...base,
      recentlyRead: {
        since: "2026-09-21T10:00:00.000Z",
        messages: [
          generalPost(
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "## A heading\n\nThe build is\ngreen.\n\nMore below.",
          ),
          generalPost("01ARZ3NDEKTSV4RRFFQ69G5FAW", long),
        ],
      },
    });
    const heading = "## Posts read here before this session (2)";
    expect(prompt).toContain(
      `${heading}\n\nThis session is new, so it holds none of the posts your earlier turns here read. These are the newest of them, posted since 2026-09-21T10:00:00.000Z, oldest first, each cut to its first paragraph: context, read already, asking nothing new of you. The board's files hold each whole by its id.\n\n- [2026-09-28T10:00:00.000Z] demo/general from @rev-1 (message 01ARZ3NDEKTSV4RRFFQ69G5FAV): The build is green.\n- [2026-09-28T10:00:00.000Z] demo/general from @rev-1 (message 01ARZ3NDEKTSV4RRFFQ69G5FAW): ${long.slice(0, 299).trimEnd()}…\n`,
    );
    // Apart from the digest, and above it.
    expect(prompt.indexOf(heading)).toBeLessThan(prompt.indexOf("## Unread messages (1)"));
    expect(prompt.split("@eng-1 the date?")).toHaveLength(2);

    // A cut never splits a character in two, and an issue's number opens a paragraph, not a heading.
    const leadOf = (body: string): string => {
      const line =
        buildTurnPrompt({
          ...base,
          recentlyRead: {
            since: "2026-09-21T10:00:00.000Z",
            messages: [generalPost("01ARZ3NDEKTSV4RRFFQ69G5FAV", body)],
          },
        })
          .split("\n")
          .find((each) => each.startsWith("- [")) ?? "";
      return line.slice(line.indexOf("): ") + 3);
    };
    expect(leadOf(`${"a".repeat(298)}😀${"b".repeat(10)}`)).toBe(`${"a".repeat(298)}…`);
    expect(leadOf(`${"a".repeat(297)}😀${"b".repeat(10)}`)).toBe(`${"a".repeat(297)}😀…`);
    expect(leadOf("#148 landed.\n\nMore below.")).toBe("#148 landed.");

    // None to show, no heading.
    for (const recentlyRead of [undefined, { since: "2026-09-21T10:00:00.000Z", messages: [] }]) {
      expect(buildTurnPrompt({ ...base, recentlyRead })).not.toContain("## Posts read here");
    }
  });

  it("makes reconciling a home's conflict copies the first step of a reflection", () => {
    const dispatch = {
      agent: "eng-1",
      project: "demo",
      trigger: TriggerSchema.parse({ kind: "reflection", reason: "scheduled reflection" }),
      priority: 0,
      onboarding: false,
    };
    const base = { messages: [], heldClaims: [], lastTurn: null, onboarding: null };
    const conflict = {
      path: "memory/core.md.conflict-0000ABCD",
      file: "memory/core.md",
      since: "2026-09-30T08:00:00.000Z",
    };
    expect(buildTurnPrompt({ ...base, dispatch })).not.toContain("Reconcile first");

    const reflection = buildTurnPrompt({ ...base, dispatch, conflicts: [conflict] });
    expect(reflection).toContain("then:\n- Reconcile first: merge each copy");
    expect(reflection.indexOf("Reconcile first")).toBeLessThan(reflection.indexOf("Consolidate"));
    expect(reflection).toContain(
      "- memory/core.md.conflict-0000ABCD, beside memory/core.md, since 2026-09-30T08:00:00.000Z",
    );

    // Any other turn lists the copies without the reflection's step.
    const heartbeat = buildTurnPrompt({
      ...base,
      dispatch: { ...dispatch, trigger: TriggerSchema.parse({ kind: "heartbeat" }) },
      conflicts: [conflict],
    });
    expect(heartbeat).toContain("## Edits to reconcile in your home");
    expect(heartbeat).not.toContain("Reconcile first");
  });
});
