#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { Board, BoardError, type Actor } from "@stellaris/board-core";
import {
  CharterTriggerSchema,
  CliKindSchema,
  CompletionEffectSchema,
  isTaskStep,
  MEMBER_VERBS,
  parseChannelRef,
  PlanEditSchema,
  PlanSchema,
  ProposalKindSchema,
  stageIndex,
  VerbNameSchema,
  type Task,
} from "@stellaris/shared";

const program = new Command();

program
  .name("stellaris")
  .description("Admin CLI for a Stellaris society: setup, posting, tasks, governance, and control")
  .version("0.0.0")
  .option("-d, --data <dir>", "data directory", process.env["STELLARIS_DATA_DIR"] ?? "./data")
  .option("--json", "print JSON instead of text", false);

interface GlobalOptions {
  readonly data: string;
  readonly json: boolean;
}

function globals(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

function print(value: unknown, human: () => string): void {
  console.log(globals().json ? JSON.stringify(value, null, 2) : human());
}

async function open(): Promise<Board> {
  return Board.open(globals().data);
}

async function actorFor(board: Board, as: string | undefined): Promise<Actor> {
  return as === undefined ? board.userActor() : board.actorFor(as);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePlan(json: string) {
  return PlanSchema.parse(JSON.parse(json));
}

/** A task's plan, one stage per line, the current one marked. */
function describePlan(task: Task): string {
  return task.stages
    .map((stage) => {
      const mark = stage.id === task.stage ? "->" : "  ";
      const who = stage.agent ?? stage.role ?? "anyone";
      const done = stage.completedBy === undefined ? "" : `, done by ${stage.completedBy}`;
      return `${mark} ${stage.id} ${stage.name} (${stage.gate ? "gate, " : ""}${who}${done})`;
    })
    .join("\n");
}

function parseCharter(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new BoardError("VALIDATION", "a charter must be a JSON object");
  }
  return parsed;
}

program
  .command("init")
  .description("Create a society in the data directory and print the user token once")
  .option("-n, --name <name>", "society name", "stellaris")
  .action(async (opts: { name: string }) => {
    const { userToken } = await Board.init(globals().data, { name: opts.name });
    print({ dataDir: globals().data, userToken }, () =>
      [
        `Society "${opts.name}" initialized in ${globals().data}`,
        `User token (shown once): ${userToken}`,
      ].join("\n"),
    );
  });

const project = program.command("project").description("Manage projects");

project
  .command("add <slug>")
  .description("Add a project with its default channels")
  .option("--name <name>", "display name")
  .option("--repo <url>", "git remote")
  .option("--on-done <effect>", "what finishing a task does: none, or merge its branch")
  .action(async (slug: string, opts: { name?: string; repo?: string; onDone?: string }) => {
    const board = await open();
    const added = await board.addProject(board.userActor(), {
      slug,
      name: opts.name,
      repo: opts.repo ?? null,
      ...(opts.onDone === undefined ? {} : { onDone: CompletionEffectSchema.parse(opts.onDone) }),
    });
    print(added, () => `Project ${added.slug} added with channels ${added.channels.join(", ")}`);
  });

project
  .command("configure <slug>")
  .description("Set a project's completion effect")
  .requiredOption("--on-done <effect>", "none, or merge")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (slug: string, opts: { onDone: string; as?: string }) => {
    const board = await open();
    const configured = await board.configureProject(await actorFor(board, opts.as), {
      project: slug,
      on_done: CompletionEffectSchema.parse(opts.onDone),
    });
    print(configured, () => `Project ${configured.slug}: on done ${configured.onDone}`);
  });

project
  .command("archive <slug>")
  .description("Archive a project with no task in play: its members leave and its threads close")
  .requiredOption("--reason <text>", "why the project is archived")
  .action(async (slug: string, opts: { reason: string }) => {
    const board = await open();
    const archived = await board.archiveProject(board.userActor(), {
      project: slug,
      reason: opts.reason,
    });
    print(archived, () => `Project ${archived.slug} archived`);
  });

project
  .command("list")
  .description("List projects")
  .action(async () => {
    const board = await open();
    const projects = await board.listProjects();
    print(projects, () =>
      projects
        .map((p) =>
          p.archived === undefined
            ? `${p.slug}\t${p.name}\tmembers: ${p.members.join(", ") || "none"}`
            : `${p.slug}\t${p.name}\tarchived ${p.archived.at} by ${p.archived.by}`,
        )
        .join("\n"),
    );
  });

const runner = program.command("runner").description("Manage runners");

runner
  .command("add <name>")
  .description("Register a runner and print its token once")
  .action(async (name: string) => {
    const board = await open();
    const { runner: added, token } = await board.addRunner(board.userActor(), name);
    print({ runner: added, token }, () =>
      [
        `Runner ${added.name} added`,
        `Token (shown once): ${token}`,
        "Start it with STELLARIS_RUNNER_TOKEN set to the token and STELLARIS_SERVER_URL to the board server.",
      ].join("\n"),
    );
  });

runner
  .command("list")
  .description("List runners and what they offer")
  .action(async () => {
    const board = await open();
    const runners = await board.listRunners();
    print(runners, () =>
      runners.length === 0
        ? "No runners yet; add one with `runner add <name>`."
        : runners
            .map(
              (each) =>
                `${each.name}  ${each.status}  ${each.os}  ${each.clis.join(",") || "no CLIs yet"}${
                  each.capabilities.length === 0 ? "" : `  ${each.capabilities.join(",")}`
                }`,
            )
            .join("\n"),
    );
  });

const agent = program.command("agent").description("Manage agents");

agent
  .command("add <name>")
  .description("Add an agent and print its board token once")
  .requiredOption("--role <role>", "role charter name")
  .option("--cli <cli>", "claude or codex")
  .option("--model <model>", "model to run the CLI with; the CLI's own default otherwise")
  .option("--runner <name>", "runner preferred for its turns; any with its CLI otherwise")
  .option("-p, --project <slug...>", "project memberships")
  .action(
    async (
      name: string,
      opts: { role: string; cli?: string; model?: string; runner?: string; project?: string[] },
    ) => {
      const board = await open();
      const cli = opts.cli === undefined ? null : CliKindSchema.parse(opts.cli);
      const { agent: added, token } = await board.addAgent(board.userActor(), {
        name,
        role: opts.role,
        cli,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.runner === undefined ? {} : { homeRunner: opts.runner }),
        memberships: opts.project ?? [],
      });
      print({ agent: added, token }, () =>
        [`Agent ${added.name} added as ${added.role}`, `Token (shown once): ${token}`].join("\n"),
      );
    },
  );

agent
  .command("runner <name> [runner]")
  .description(
    "Show or set the runner a citizen's work outside any project runs on; `none` pins it again on its next turn",
  )
  .action(async (name: string, chosen: string | undefined) => {
    const board = await open();
    if (chosen === undefined) {
      const current = await board.readAgent(name);
      print({ agent: name, homeRunner: current.homeRunner ?? null }, () =>
        current.homeRunner === undefined
          ? `${name} is not pinned; its next turn outside a project pins it`
          : `${name} runs on ${current.homeRunner}`,
      );
      return;
    }
    const updated = await board.setAgentRunner(
      board.userActor(),
      name,
      chosen === "none" ? null : chosen,
    );
    print({ agent: name, homeRunner: updated.homeRunner ?? null }, () =>
      updated.homeRunner === undefined
        ? `${name} will be pinned on its next turn`
        : `${name} runs on ${updated.homeRunner} from its next turn`,
    );
  });

agent
  .command("list")
  .description("List agents")
  .action(async () => {
    const board = await open();
    const agents = await board.listAgents();
    const members = await board.listMembers();
    print(agents, () =>
      agents
        .map((a) => {
          const model =
            members.find((m) => m.name === a.name)?.lastModel ?? a.model ?? "cli default";
          return `${a.name}\t${a.role}\t${a.cli ?? "human"}\t${model}\t${a.status}`;
        })
        .join("\n"),
    );
  });

agent
  .command("model <name> [model]")
  .description(
    "Set the model a member's turns run with, from its next turn; no model means the CLI's default",
  )
  .action(async (name: string, model: string | undefined) => {
    const board = await open();
    const updated = await board.setAgentModel(board.userActor(), name, model ?? null);
    print(
      updated,
      () =>
        `${updated.name} runs with ${updated.model ?? "its CLI's default model"} from its next turn`,
    );
  });

agent
  .command("retire <name>")
  .description("Retire a member: no more wakes, claims released, token revoked, sessions archived")
  .requiredOption("--reason <text>", "why")
  .action(async (name: string, opts: { reason: string }) => {
    const board = await open();
    const retired = await board.retireAgent(board.userActor(), { name, reason: opts.reason });
    print(retired, () => `Agent ${retired.name} retired: ${opts.reason}`);
  });

const proposal = program.command("proposal").description("Governance proposals");

proposal
  .command("list")
  .description("List proposals")
  .action(async () => {
    const board = await open();
    const proposals = await board.listProposals();
    print(proposals, () =>
      proposals.length === 0
        ? "No proposals."
        : proposals.map((p) => `${p.id}\t${p.kind}\t${p.status}\tby ${p.proposedBy}`).join("\n"),
    );
  });

proposal
  .command("show <id>")
  .description("Show a proposal with its charter and rationale")
  .action(async (id: string) => {
    const board = await open();
    const found = await board.readProposal(id);
    print(found, () =>
      [
        `${found.id}  ${found.kind}  ${found.status}  by ${found.proposedBy}`,
        JSON.stringify(found.charter, null, 2),
        found.body.trim(),
        found.provision === undefined ? "" : `provisioned: ${JSON.stringify(found.provision)}`,
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  });

proposal
  .command("create")
  .description("Propose a member, role, channel, reallocation, or retirement")
  .requiredOption("--kind <kind>", "member, role, channel, reallocation, or retirement")
  .requiredOption("--charter <json>", "the charter as a JSON object")
  .option("--rationale <text>", "why", "")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (opts: { kind: string; charter: string; rationale: string; as?: string }) => {
    const board = await open();
    const created = await board.propose(await actorFor(board, opts.as), {
      kind: ProposalKindSchema.parse(opts.kind),
      charter: parseCharter(opts.charter),
      rationale: opts.rationale,
    });
    print(created, () => `Proposal ${created.id} (${created.kind}) is ${created.status}`);
  });

proposal
  .command("approve <id>")
  .description("Approve a proposal; the board provisions it")
  .option("--reason <text>", "a note for the record")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (id: string, opts: { reason?: string; as?: string }) => {
    const board = await open();
    const decision = await board.approve(await actorFor(board, opts.as), {
      proposal_id: id,
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    });
    const after = await board.readProposal(id);
    print(
      { decision, proposal: after },
      () => `Proposal ${id} approved; it is now ${after.status}`,
    );
  });

proposal
  .command("reject <id>")
  .description("Reject a proposal with a reason")
  .requiredOption("--reason <text>", "why")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (id: string, opts: { reason: string; as?: string }) => {
    const board = await open();
    const decision = await board.reject(await actorFor(board, opts.as), {
      proposal_id: id,
      reason: opts.reason,
    });
    print(decision, () => `Proposal ${id} rejected`);
  });

const role = program.command("role").description("Role charters");

role
  .command("list")
  .description("List role charters")
  .action(async () => {
    const board = await open();
    const roles = await board.listRoles();
    print(roles, () =>
      roles
        .map(
          (r) =>
            `${r.name}\treplicas up to ${r.maxReplicas}\tbacklog threshold ${r.backlogThreshold}\twakes on ${r.wakeTriggers.join(", ") || "direct wakes only"}`,
        )
        .join("\n"),
    );
  });

role
  .command("add <name>")
  .description("Write a new role charter directly as the user")
  .requiredOption("--purpose <text>", "what the role is for; its members read this every turn")
  .option("--verbs <verbs...>", "board verbs granted; the member verbs by default")
  .option("--triggers <triggers...>", "wakes it opts into: user_post, ops_event, heartbeat", [
    "heartbeat",
  ])
  .action(async (name: string, opts: { purpose: string; verbs?: string[]; triggers: string[] }) => {
    const board = await open();
    const added = await board.setRoleCharter(board.userActor(), {
      name,
      purpose: opts.purpose,
      verbs:
        opts.verbs === undefined
          ? [...MEMBER_VERBS]
          : opts.verbs.map((verb) => VerbNameSchema.parse(verb)),
      wakeTriggers: opts.triggers.map((trigger) => CharterTriggerSchema.parse(trigger)),
    });
    print(added, () => `Role ${added.name} written with ${added.verbs.length} verbs`);
  });

role
  .command("set <name>")
  .description("Change a charter directly as the user: scaling cap, threshold, or purpose")
  .option("--max-replicas <n>", "active members of the role per project the scheduler may reach")
  .option("--backlog-threshold <n>", "load per member that adds a replica")
  .option("--purpose <text>", "the charter's purpose")
  .action(
    async (
      name: string,
      opts: { maxReplicas?: string; backlogThreshold?: string; purpose?: string },
    ) => {
      const board = await open();
      const current = await board.readRole(name);
      const updated = await board.setRoleCharter(board.userActor(), {
        ...current,
        ...(opts.maxReplicas === undefined ? {} : { maxReplicas: Number(opts.maxReplicas) }),
        ...(opts.backlogThreshold === undefined
          ? {}
          : { backlogThreshold: Number(opts.backlogThreshold) }),
        ...(opts.purpose === undefined ? {} : { purpose: opts.purpose }),
      });
      print(
        updated,
        () =>
          `Role ${updated.name}: replicas up to ${updated.maxReplicas}, backlog threshold ${updated.backlogThreshold}`,
      );
    },
  );

const channelCommand = program.command("channel").description("Channels");

channelCommand
  .command("add <ref>")
  .description("Open a channel: <name> for the society or <project>/<name>")
  .requiredOption("--purpose <text>", "what the channel is for")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (ref: string, opts: { purpose: string; as?: string }) => {
    const board = await open();
    const parsed = parseChannelRef(ref);
    const added = await board.addChannel(await actorFor(board, opts.as), {
      project: parsed.project,
      name: parsed.channel,
      purpose: opts.purpose,
    });
    print({ channel: added }, () => `Channel ${added} opened`);
  });

program
  .command("signals")
  .description("Recent operations signals, oldest first")
  .option("--limit <n>", "how many", "50")
  .action(async (opts: { limit: string }) => {
    const board = await open();
    const signals = await board.listSignals(Number(opts.limit));
    print(signals, () =>
      signals.length === 0
        ? "No signals yet."
        : signals.map((s) => `[${s.ts}] ${s.signal.kind}\t${s.signal.summary}`).join("\n"),
    );
  });

program
  .command("post <channel> <body>")
  .description("Post a message to a channel, or into one of its threads")
  .option("--as <agent>", "act as this agent instead of the user")
  .option("--thread <threadId>", "post into the thread, which must hang off the channel")
  .action(async (channel: string, body: string, opts: { as?: string; thread?: string }) => {
    const board = await open();
    const who = await actorFor(board, opts.as);
    const message = await board.postMessage(who, {
      channel,
      body,
      ...(opts.thread === undefined ? {} : { thread_id: opts.thread }),
    });
    print(
      message,
      () =>
        `Posted ${message.id} to ${message.channel}${message.thread === undefined ? "" : ` (thread ${message.thread})`}`,
    );
  });

program
  .command("ask <text>")
  .description("Post to the society's general channel as the user; the front desk routes it")
  .action(async (text: string) => {
    const board = await open();
    const message = await board.postMessage(board.userActor(), { channel: "general", body: text });
    print(message, () => `Posted ${message.id} to general; the concierge wakes on it`);
  });

const task = program.command("task").description("Manage tasks");

task
  .command("create <project> <title>")
  .description("Create a task with a plan, or with one stage anyone in the project may take")
  .option("--body <text>", "task body", "")
  .option("--parent <id>", "parent task id")
  .option("--plan <json>", 'stages, for example \'[{"name":"analysis","role":"analyst"}]\'')
  .option("--as <agent>", "act as this agent instead of the user")
  .action(
    async (
      projectSlug: string,
      title: string,
      opts: { body: string; parent?: string; plan?: string; as?: string },
    ) => {
      const board = await open();
      const who = await actorFor(board, opts.as);
      const created = await board.createTask(who, {
        project: projectSlug,
        title,
        body: opts.body,
        ...(opts.parent === undefined ? {} : { parent_id: opts.parent }),
        ...(opts.plan === undefined ? {} : { stages: parsePlan(opts.plan) }),
      });
      print(created, () =>
        [
          `Task ${created.id} created in ${created.project}: ${created.title}`,
          describePlan(created),
        ].join("\n"),
      );
    },
  );

task
  .command("claim <id>")
  .description("Hold the task's current stage")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (id: string, opts: { as?: string }) => {
    const board = await open();
    const claimed = await board.claimTask(await actorFor(board, opts.as), { task_id: id });
    print(
      claimed,
      () =>
        `Stage ${claimed.stage} of task ${claimed.id} held by ${claimed.claimedBy ?? "?"} until ${claimed.leaseExpiresAt ?? "?"}`,
    );
  });

task
  .command("release <id>")
  .description("Let go of the stage held on a task")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (id: string, opts: { as?: string }) => {
    const board = await open();
    const released = await board.releaseTask(await actorFor(board, opts.as), { task_id: id });
    print(released, () => `Stage ${released.stage} of task ${released.id} released`);
  });

task
  .command("advance <id>")
  .description("Finish the current stage; past the last one the task is done")
  .option("--note <text>", "what was done, posted to the task's thread")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (id: string, opts: { note?: string; as?: string }) => {
    const board = await open();
    const advanced = await board.advanceTask(await actorFor(board, opts.as), {
      task_id: id,
      ...(opts.note === undefined ? {} : { note: opts.note }),
    });
    print(advanced, () =>
      advanced.status === "done"
        ? `Task ${advanced.id} is done`
        : advanced.completing
          ? `Task ${advanced.id} is completing: ${advanced.onDone}`
          : `Task ${advanced.id} is at ${advanced.stage}\n${describePlan(advanced)}`,
    );
  });

task
  .command("plan <id> <stages>")
  .description(
    "Reshape the stages ahead: pass existing stages with their id to keep them, new ones without",
  )
  .option("--on-done <effect>", "override the completion effect for this task")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (id: string, stages: string, opts: { onDone?: string; as?: string }) => {
    const board = await open();
    const planned = await board.planTask(await actorFor(board, opts.as), {
      task_id: id,
      stages: PlanEditSchema.parse(JSON.parse(stages)),
      ...(opts.onDone === undefined ? {} : { on_done: CompletionEffectSchema.parse(opts.onDone) }),
    });
    print(planned, () => describePlan(planned));
  });

task
  .command("update <id>")
  .description(
    "Send a task back to an earlier stage, abandon it, or set blockers, with a note for its thread",
  )
  .option("--stage <stageId>", "move back to this earlier stage")
  .option("--abandon", "abandon the task", false)
  .option("--note <text>", "a note, posted to the task's thread")
  .option("--blocked-by <ids...>", "task ids this task waits on")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(
    async (
      id: string,
      opts: { stage?: string; abandon: boolean; note?: string; blockedBy?: string[]; as?: string },
    ) => {
      const board = await open();
      const updated = await board.updateTask(await actorFor(board, opts.as), {
        task_id: id,
        ...(opts.stage === undefined ? {} : { stage: opts.stage }),
        ...(opts.abandon ? { status: "abandoned" as const } : {}),
        ...(opts.note === undefined ? {} : { note: opts.note }),
        ...(opts.blockedBy === undefined ? {} : { blocked_by: opts.blockedBy }),
      });
      print(updated, () => `Task ${updated.id} is ${updated.status} at ${updated.stage}`);
    },
  );

task
  .command("show <id>")
  .description("Show a task with its plan and its thread")
  .action(async (id: string) => {
    const board = await open();
    const found = await board.getTask(board.userActor(), { task_id: id });
    const threadState = await board
      .readThread(id)
      .then((t) => t.state)
      .catch(() => "none");
    const said = found.messages.map((message) => {
      const step = message.step;
      const marker =
        step === undefined
          ? ""
          : isTaskStep(step)
            ? ` [${step.action} ${step.stage}${step.to === null ? "" : ` → ${step.to}`}]`
            : ` [${step.action}]`;
      return `${message.ts}  ${message.author}${marker}\n${message.body.trim()}\n`;
    });
    print(found, () =>
      [
        `${found.id}  ${found.status}${found.completing ? " (completing)" : ""}  ${found.title}`,
        `project: ${found.project}  held by: ${found.claimedBy ?? "nobody"}  on done: ${found.onDone}  thread: ${threadState}`,
        describePlan(found),
        "",
        found.body.trim(),
        ...(said.length === 0 ? [] : ["", "Thread:", "", ...said]),
      ].join("\n"),
    );
  });

task
  .command("list <project>")
  .description("List a project's tasks with their current stage")
  .action(async (projectSlug: string) => {
    const board = await open();
    const tasks = await board.listTasks(projectSlug);
    print(tasks, () =>
      tasks.length === 0
        ? "No tasks."
        : tasks
            .map((t) => {
              const stage = t.stages[stageIndex(t, t.stage)];
              return `${t.id}\t${t.status}\t${stage?.name ?? t.stage}\t${t.claimedBy ?? "-"}\t${t.title}`;
            })
            .join("\n"),
    );
  });

const thread = program.command("thread").description("Manage threads");

thread
  .command("open [taskId]")
  .description("Open a thread on a task, on a proposal, or on a channel with a title")
  .option("--proposal <id>", "open the proposal's thread")
  .option("--channel <ref>", "the channel it hangs off; required for a topic")
  .option("--title <text>", "the thread's title; required for a topic")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(
    async (
      taskId: string | undefined,
      opts: { proposal?: string; channel?: string; title?: string; as?: string },
    ) => {
      const board = await open();
      const opened = await board.openThread(await actorFor(board, opts.as), {
        ...(taskId === undefined ? {} : { task_id: taskId }),
        ...(opts.proposal === undefined ? {} : { proposal_id: opts.proposal }),
        ...(opts.channel === undefined ? {} : { channel: opts.channel }),
        ...(opts.title === undefined ? {} : { title: opts.title }),
      });
      print(opened, () => `Thread ${opened.id} opened on ${opened.channel}: ${opened.title}`);
    },
  );

thread
  .command("close <threadId>")
  .description("Close a thread with a summary posted to its channel")
  .requiredOption("--summary <text>", "closure summary")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (threadId: string, opts: { summary: string; as?: string }) => {
    const board = await open();
    const summary = await board.closeThread(await actorFor(board, opts.as), {
      thread_id: threadId,
      summary: opts.summary,
    });
    print(summary, () => `Thread closed; summary posted as ${summary.id} to ${summary.channel}`);
  });

thread
  .command("list")
  .description("List threads, the society's first, then each project's")
  .option("--open", "only open threads", false)
  .action(async (opts: { open: boolean }) => {
    const board = await open();
    const threads = (await board.listThreads()).filter((t) => !opts.open || t.state === "open");
    print(threads, () =>
      threads.length === 0
        ? "No threads."
        : threads
            .map((t) => {
              const about = t.subject === undefined ? "topic" : t.subject.kind;
              return `${t.id}\t${t.state}\t${t.channel}\t${about}\t${t.title}`;
            })
            .join("\n"),
    );
  });

thread
  .command("show <threadId>")
  .description("Show a thread and its messages")
  .action(async (threadId: string) => {
    const board = await open();
    const found = await board.readThread(threadId);
    const messages = await board.listThread(threadId);
    print({ thread: found, messages }, () =>
      [
        `${found.id}  ${found.state}  ${found.channel}  ${found.title}`,
        `opened by ${found.openedBy} at ${found.openedAt}${
          found.closedBy === undefined
            ? ""
            : `; closed by ${found.closedBy} at ${found.closedAt ?? "?"}`
        }`,
        ...messages.map((m) => `[${m.ts}] @${m.author}: ${m.body.trim()}`),
        ...(found.body.trim().length === 0 ? [] : ["", `Summary: ${found.body.trim()}`]),
      ].join("\n"),
    );
  });

program
  .command("pause")
  .description("Stop all wakeups; turns in flight finish")
  .action(async () => {
    const board = await open();
    await board.setPaused(board.userActor(), true);
    print({ paused: true }, () => "Society paused");
  });

program
  .command("resume")
  .description("Allow wakeups again")
  .action(async () => {
    const board = await open();
    await board.setPaused(board.userActor(), false);
    print({ paused: false }, () => "Society resumed");
  });

const knowledge = program
  .command("knowledge")
  .description("Shared knowledge, by project or society");

knowledge
  .command("list [project]")
  .description("List knowledge topics of a project, or of the society when no project is given")
  .action(async (projectSlug: string | undefined) => {
    const board = await open();
    const topics = await board.listKnowledge(projectSlug ?? null);
    print(topics, () =>
      topics.length === 0
        ? "No knowledge yet."
        : topics.map((t) => `${t.topic}\tupdated by ${t.updatedBy} at ${t.updatedAt}`).join("\n"),
    );
  });

knowledge
  .command("show <topic>")
  .description("Print a knowledge topic")
  .option("--project <slug>", "the project's topic instead of the society's")
  .action(async (topic: string, opts: { project?: string }) => {
    const board = await open();
    const found = (await board.listKnowledge(opts.project ?? null)).find((t) => t.topic === topic);
    if (found === undefined) {
      throw new BoardError("NOT_FOUND", `no knowledge topic ${topic}`);
    }
    print(found, () => found.body);
  });

knowledge
  .command("write <topic>")
  .description("Write a knowledge topic as the user, from a file or standard input")
  .option("--project <slug>", "the project's topic instead of the society's")
  .option("--file <path>", "read the body from this file instead of standard input")
  .option("--as <agent>", "act as this agent instead of the user")
  .action(async (topic: string, opts: { project?: string; file?: string; as?: string }) => {
    const board = await open();
    const body =
      opts.file === undefined ? await readStdin() : await readFile(path.resolve(opts.file), "utf8");
    const written = await board.writeKnowledge(await actorFor(board, opts.as), {
      project: opts.project ?? null,
      topic,
      body,
    });
    print(written, () => `Wrote ${written.topic} for ${written.project ?? "the society"}`);
  });

program
  .command("skill")
  .description("Skills promoted to the society")
  .command("list")
  .description("List the society's skills, and each member's own")
  .action(async () => {
    const board = await open();
    const society = await board.listSocietySkills();
    const own: Array<{ agent: string; skills: Awaited<ReturnType<typeof board.listAgentSkills>> }> =
      [];
    for (const member of await board.listAgents()) {
      const skills = await board.listAgentSkills(member.name);
      if (skills.length > 0) {
        own.push({ agent: member.name, skills });
      }
    }
    print(
      { society, own },
      () =>
        [
          ...society.map((s) => `society\t${s.name}\t${s.summary}`),
          ...own.flatMap(({ agent: name, skills }) =>
            skills.map((s) => `${name}\t${s.name}\t${s.summary}`),
          ),
        ].join("\n") || "No skills yet.",
    );
  });

const turn = program.command("turn").description("Turn operations");

turn
  .command("digest <agent>")
  .description(
    "Show the unread messages the agent's next turn opens with, in one scope or all; the cursors stay put",
  )
  .option("--limit <n>", "maximum messages", "50")
  .option("--project <slug>", "the scope whose turn to show: a project, or society")
  .action(async (agentName: string, opts: { limit: string; project?: string }) => {
    const board = await open();
    const actor = await board.actorFor(agentName);
    const digest = await board.readDigest(
      opts.project === undefined ? actor : { ...actor, scope: opts.project },
      { advance: false, limit: Number(opts.limit) },
    );
    print(digest, () =>
      digest.messages.length === 0
        ? "No unread messages."
        : digest.messages
            .map(
              (m) =>
                `[${m.ts}] ${m.channel}${m.thread === undefined ? "" : ` (thread ${m.thread})`} @${m.author}: ${m.body.trim()}`,
            )
            .join("\n"),
    );
  });

turn
  .command("run <agent>")
  .description("Enqueue a manual wake for an agent on a project, or a reflection turn")
  .requiredOption("--project <slug>", "project to act on, or society for a society-scope turn")
  .option("--reason <text>", "why", "manual wake from the admin CLI")
  .option("--reflect", "a reflection turn instead of a working turn", false)
  .action(
    async (agentName: string, opts: { project: string; reason: string; reflect: boolean }) => {
      const board = await open();
      const event = await board.requestWake(board.userActor(), {
        agent: agentName,
        project: opts.project,
        reason: opts.reason,
        kind: opts.reflect ? "reflection" : "manual",
      });
      print(
        event,
        () =>
          `${opts.reflect ? "Reflection" : "Wake"} requested for ${agentName} on ${opts.project} (event ${event.id}). A running board server dispatches it.`,
      );
    },
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof BoardError) {
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
