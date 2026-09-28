#!/usr/bin/env node
import { Command } from "commander";
import { Board, BoardError, type Actor } from "@stellaris/board-core";
import {
  CliKindSchema,
  parseChannelRef,
  ProposalKindSchema,
  TaskStatusSchema,
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
  return as === undefined ? board.ownerActor() : board.actorFor(as);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  .description("Create a society in the data directory and print the owner token once")
  .option("-n, --name <name>", "society name", "stellaris")
  .action(async (opts: { name: string }) => {
    const { ownerToken } = await Board.init(globals().data, { name: opts.name });
    print({ dataDir: globals().data, ownerToken }, () =>
      [
        `Society "${opts.name}" initialized in ${globals().data}`,
        `Owner token (shown once): ${ownerToken}`,
      ].join("\n"),
    );
  });

const project = program.command("project").description("Manage projects");

project
  .command("add <slug>")
  .description("Add a project with its default channels")
  .option("--name <name>", "display name")
  .option("--repo <url>", "git remote")
  .action(async (slug: string, opts: { name?: string; repo?: string }) => {
    const board = await open();
    const added = await board.addProject(board.ownerActor(), {
      slug,
      name: opts.name,
      repo: opts.repo ?? null,
    });
    print(added, () => `Project ${added.slug} added with channels ${added.channels.join(", ")}`);
  });

project
  .command("list")
  .description("List projects")
  .action(async () => {
    const board = await open();
    const projects = await board.listProjects();
    print(projects, () =>
      projects
        .map((p) => `${p.slug}\t${p.name}\tmembers: ${p.members.join(", ") || "none"}`)
        .join("\n"),
    );
  });

const agent = program.command("agent").description("Manage agents");

agent
  .command("add <name>")
  .description("Add an agent and print its board token once")
  .requiredOption("--role <role>", "role charter name, for example engineer or reviewer")
  .option("--cli <cli>", "claude or codex")
  .option("--runner <name>", "home runner", "local")
  .option("-p, --project <slug...>", "project memberships")
  .action(
    async (
      name: string,
      opts: { role: string; cli?: string; runner: string; project?: string[] },
    ) => {
      const board = await open();
      const cli = opts.cli === undefined ? null : CliKindSchema.parse(opts.cli);
      const { agent: added, token } = await board.addAgent(board.ownerActor(), {
        name,
        role: opts.role,
        cli,
        homeRunner: opts.runner,
        memberships: opts.project ?? [],
      });
      print({ agent: added, token }, () =>
        [`Agent ${added.name} added as ${added.role}`, `Token (shown once): ${token}`].join("\n"),
      );
    },
  );

agent
  .command("list")
  .description("List agents")
  .action(async () => {
    const board = await open();
    const agents = await board.listAgents();
    print(agents, () =>
      agents.map((a) => `${a.name}\t${a.role}\t${a.cli ?? "human"}\t${a.status}`).join("\n"),
    );
  });

agent
  .command("retire <name>")
  .description("Retire a member: no more wakes, claims released, token revoked, sessions archived")
  .requiredOption("--reason <text>", "why")
  .action(async (name: string, opts: { reason: string }) => {
    const board = await open();
    const retired = await board.retireAgent(board.ownerActor(), { name, reason: opts.reason });
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
  .option("--as <agent>", "act as this agent instead of the owner")
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
  .option("--as <agent>", "act as this agent instead of the owner")
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
  .option("--as <agent>", "act as this agent instead of the owner")
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
            `${r.name}\trepo ${r.repoPermission}\treplicas up to ${r.maxReplicas}\tbacklog threshold ${r.backlogThreshold}\twakes on ${r.wakeTriggers.join(", ") || "nothing"}`,
        )
        .join("\n"),
    );
  });

role
  .command("set <name>")
  .description("Change a charter directly as the owner: scaling cap, threshold, or purpose")
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
      const updated = await board.setRoleCharter(board.ownerActor(), {
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
  .option("--as <agent>", "act as this agent instead of the owner")
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
  .description("Post a message to a channel, or into a task's thread")
  .option("--as <agent>", "act as this agent instead of the owner")
  .option("--thread <taskId>", "post into the task's thread")
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
  .description("Post to the society's general channel as the owner; the front desk routes it")
  .action(async (text: string) => {
    const board = await open();
    const message = await board.postMessage(board.ownerActor(), { channel: "general", body: text });
    print(message, () => `Posted ${message.id} to general; the concierge wakes on it`);
  });

program
  .command("inbox")
  .description("Read unread messages for an agent and advance its cursor")
  .option("--as <agent>", "act as this agent instead of the owner")
  .option("--peek", "do not advance the cursor", false)
  .option("--limit <n>", "maximum messages", "50")
  .action(async (opts: { as?: string; peek: boolean; limit: string }) => {
    const board = await open();
    const who = await actorFor(board, opts.as);
    const inbox = await board.readInbox(who, { advance: !opts.peek, limit: Number(opts.limit) });
    print(inbox, () =>
      inbox.messages.length === 0
        ? "No unread messages."
        : inbox.messages
            .map(
              (m) =>
                `[${m.ts}] ${m.channel}${m.thread === undefined ? "" : ` (thread ${m.thread})`} @${m.author}: ${m.body.trim()}`,
            )
            .join("\n"),
    );
  });

const task = program.command("task").description("Manage tasks");

task
  .command("create <project> <title>")
  .description("Create a task")
  .option("--body <text>", "task body", "")
  .option("--parent <id>", "parent task id")
  .option("--as <agent>", "act as this agent instead of the owner")
  .action(
    async (
      projectSlug: string,
      title: string,
      opts: { body: string; parent?: string; as?: string },
    ) => {
      const board = await open();
      const who = await actorFor(board, opts.as);
      const created = await board.createTask(who, {
        project: projectSlug,
        title,
        body: opts.body,
        ...(opts.parent === undefined ? {} : { parent_id: opts.parent }),
      });
      print(created, () => `Task ${created.id} created in ${created.project}: ${created.title}`);
    },
  );

task
  .command("claim <id>")
  .description("Claim an open task")
  .option("--as <agent>", "act as this agent instead of the owner")
  .action(async (id: string, opts: { as?: string }) => {
    const board = await open();
    const claimed = await board.claimTask(await actorFor(board, opts.as), { task_id: id });
    print(
      claimed,
      () =>
        `Task ${claimed.id} claimed by ${claimed.claimedBy ?? "?"} until ${claimed.leaseExpiresAt ?? "?"}`,
    );
  });

task
  .command("release <id>")
  .description("Release a claimed task")
  .option("--as <agent>", "act as this agent instead of the owner")
  .action(async (id: string, opts: { as?: string }) => {
    const board = await open();
    const released = await board.releaseTask(await actorFor(board, opts.as), { task_id: id });
    print(released, () => `Task ${released.id} released`);
  });

task
  .command("update <id>")
  .description("Change status, add a note, or set blockers")
  .option("--status <status>", "open, claimed, in_review, done, blocked, abandoned")
  .option("--note <text>", "append a note")
  .option("--blocked-by <ids...>", "task ids this task waits on")
  .option("--as <agent>", "act as this agent instead of the owner")
  .action(
    async (
      id: string,
      opts: { status?: string; note?: string; blockedBy?: string[]; as?: string },
    ) => {
      const board = await open();
      const updated = await board.updateTask(await actorFor(board, opts.as), {
        task_id: id,
        ...(opts.status === undefined ? {} : { status: TaskStatusSchema.parse(opts.status) }),
        ...(opts.note === undefined ? {} : { note: opts.note }),
        ...(opts.blockedBy === undefined ? {} : { blocked_by: opts.blockedBy }),
      });
      print(updated, () => `Task ${updated.id} is now ${updated.status}`);
    },
  );

task
  .command("show <id>")
  .description("Show a task")
  .action(async (id: string) => {
    const board = await open();
    const found = await board.getTask(board.ownerActor(), { task_id: id });
    print(found, () =>
      [
        `${found.id}  ${found.status}  ${found.title}`,
        `project: ${found.project}  claimed by: ${found.claimedBy ?? "nobody"}  thread: ${found.thread}`,
        "",
        found.body.trim(),
      ].join("\n"),
    );
  });

task
  .command("list <project>")
  .description("List a project's tasks")
  .action(async (projectSlug: string) => {
    const board = await open();
    const tasks = await board.listTasks(projectSlug);
    print(tasks, () =>
      tasks.length === 0
        ? "No tasks."
        : tasks.map((t) => `${t.id}\t${t.status}\t${t.claimedBy ?? "-"}\t${t.title}`).join("\n"),
    );
  });

const thread = program.command("thread").description("Manage task threads");

thread
  .command("open <taskId>")
  .description("Open a task's thread")
  .option("--as <agent>", "act as this agent instead of the owner")
  .action(async (taskId: string, opts: { as?: string }) => {
    const board = await open();
    const opened = await board.openThread(await actorFor(board, opts.as), { task_id: taskId });
    print(opened, () => `Thread opened for task ${opened.id}`);
  });

thread
  .command("close <taskId>")
  .description("Close a task's thread with a summary posted to the project channel")
  .requiredOption("--summary <text>", "closure summary")
  .option("--as <agent>", "act as this agent instead of the owner")
  .action(async (taskId: string, opts: { summary: string; as?: string }) => {
    const board = await open();
    const summary = await board.closeThread(await actorFor(board, opts.as), {
      thread_id: taskId,
      summary: opts.summary,
    });
    print(summary, () => `Thread closed; summary posted as ${summary.id} to ${summary.channel}`);
  });

program
  .command("pause")
  .description("Stop all wakeups; turns in flight finish")
  .action(async () => {
    const board = await open();
    await board.setPaused(board.ownerActor(), true);
    print({ paused: true }, () => "Society paused");
  });

program
  .command("resume")
  .description("Allow wakeups again")
  .action(async () => {
    const board = await open();
    await board.setPaused(board.ownerActor(), false);
    print({ paused: false }, () => "Society resumed");
  });

program
  .command("turn")
  .description("Turn operations")
  .command("run <agent>")
  .description("Enqueue a manual wake for an agent on a project")
  .requiredOption("--project <slug>", "project to act on")
  .option("--reason <text>", "why", "manual wake from the admin CLI")
  .action(async (agentName: string, opts: { project: string; reason: string }) => {
    const board = await open();
    const event = await board.requestWake(board.ownerActor(), {
      agent: agentName,
      project: opts.project,
      reason: opts.reason,
    });
    print(
      event,
      () =>
        `Wake requested for ${agentName} on ${opts.project} (event ${event.id}). A running board server dispatches it.`,
    );
  });

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
