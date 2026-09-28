#!/usr/bin/env node
import { Command } from "commander";
import { Board, BoardError, type Actor } from "@stellaris/board-core";
import { CliKindSchema, TaskStatusSchema } from "@stellaris/shared";

const program = new Command();

program
  .name("stellaris")
  .description("Admin CLI for a Stellaris society: setup, posting, tasks, and control")
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
  .action(() => {
    console.error("turn run: the scheduler dispatch arrives in Phase 1. See PLAN.md section 5.6.");
    process.exitCode = 2;
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
