import { writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { SYSTEM_ACTOR, type Actor, type Board } from "@stellaris/board-core";
import {
  OWNER_NAME,
  turnStatusJsonSchema,
  type AgentEvent,
  type CliKind,
  type Name,
  type TurnDispatch,
  type TurnRecord,
  type Ulid,
} from "@stellaris/shared";
import { ExecaGit, type GitOps } from "./git.js";
import { buildTurnPrompt } from "./prompt.js";
import {
  renderClaudeMcpConfig,
  renderCodexMcpConfig,
  renderInstructions,
  type OnboardingContext,
} from "./render.js";
import { ZERO_USAGE, type AgentBackend, type TurnResult } from "./types.js";

export interface RunnerLog {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface LocalRunnerOptions {
  readonly board: Board;
  readonly backends: Partial<Record<CliKind, AgentBackend>>;
  /** Where agents reach the board's MCP endpoint, for example http://127.0.0.1:4700/mcp */
  readonly mcpUrl: string;
  readonly runnerName?: Name | undefined;
  readonly turnTimeoutMs?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly git?: GitOps | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: RunnerLog | undefined;
  readonly onEvent?: ((agent: Name, project: Name, event: AgentEvent) => void) | undefined;
}

const SILENT: RunnerLog = { info() {}, warn() {}, error() {} };
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_MAX_TURNS = 60;

/**
 * The embedded runner: ensures the worktree, renders the config home, builds the prompt,
 * runs the turn through the CLI's adapter, then records the outcome on the board.
 * Remote runners will do the same behind a WebSocket; the board never knows the difference.
 */
export class LocalRunner {
  private readonly board: Board;
  private readonly backends: Partial<Record<CliKind, AgentBackend>>;
  private readonly mcpUrl: string;
  private readonly runnerName: Name;
  private readonly turnTimeoutMs: number;
  private readonly maxTurns: number;
  private readonly git: GitOps;
  private readonly now: () => Date;
  private readonly log: RunnerLog;
  private readonly onEvent: ((agent: Name, project: Name, event: AgentEvent) => void) | undefined;
  private readonly prepareLocks = new Map<Name, Promise<void>>();

  constructor(options: LocalRunnerOptions) {
    this.board = options.board;
    this.backends = options.backends;
    this.mcpUrl = options.mcpUrl;
    this.runnerName = options.runnerName ?? "local";
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.git = options.git ?? new ExecaGit();
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? SILENT;
    this.onEvent = options.onEvent;
  }

  /** Clones the project once and adds the pair's worktree. Idempotent. */
  async prepare(
    agent: Name,
    project: Name,
  ): Promise<{ repoDir: string; worktree: string; branch: string }> {
    // Two first turns on one project must not both initialize its repository: serialize per project.
    const previous = this.prepareLocks.get(project) ?? Promise.resolve();
    const run = previous.then(
      () => this.prepareUnlocked(agent, project),
      () => this.prepareUnlocked(agent, project),
    );
    this.prepareLocks.set(
      project,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async prepareUnlocked(
    agent: Name,
    project: Name,
  ): Promise<{ repoDir: string; worktree: string; branch: string }> {
    const record = await this.board.readProject(project);
    const repoDir = await this.git.ensureRepo(record, this.board.paths.repo(project));
    const branch = `agent/${agent}`;
    const worktree = await this.git.ensureWorktree(
      repoDir,
      this.board.paths.worktree(agent, project),
      branch,
      record.defaultBranch,
    );
    return { repoDir, worktree, branch };
  }

  async runTurn(dispatch: TurnDispatch): Promise<TurnRecord> {
    const agent = await this.board.readAgent(dispatch.agent);
    const actor: Actor = { name: agent.name, role: agent.role };
    const startedAt = this.now().toISOString();
    const base: TurnRecord = {
      agent: agent.name,
      project: dispatch.project,
      runner: this.runnerName,
      cli: agent.cli,
      session: null,
      trigger: dispatch.trigger,
      startedAt,
      endedAt: null,
      exitReason: null,
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
    };

    if (agent.status === "retired") {
      return this.fail(base, `${agent.name} is retired`);
    }
    if (agent.cli === null) {
      return this.fail(base, `${agent.name} has no CLI binding`);
    }
    const backend = this.backends[agent.cli];
    if (backend === undefined) {
      return this.fail(base, `no backend registered for ${agent.cli}`);
    }

    const { worktree, repoDir } = await this.prepare(agent.name, dispatch.project);
    const sessions = await this.board.readSessions(agent.name, dispatch.project);
    const spec = {
      agent: agent.name,
      project: dispatch.project,
      cli: agent.cli,
      cwd: worktree,
      repoDir,
      configHome: this.board.paths.agent(agent.name),
      boardDir: this.board.paths.board,
      ...(agent.model === undefined ? {} : { model: agent.model }),
    };
    let session = sessions[agent.cli];
    const newSession = session === undefined;
    if (session === undefined) {
      session = await backend.newSession(spec);
      // Written before the turn runs so a crash cannot lose the id.
      await this.board.writeSession(agent.name, dispatch.project, agent.cli, session);
    }

    const lastTurn = await this.board.readLastTurn(agent.name, dispatch.project);
    const inbox = await this.board.readInbox(actor, { advance: false, limit: 50 });
    const held = await this.board.heldClaims(agent.name);
    const roleCharter = await this.board.readAgentRoleBody(agent.name);
    const memoryCore = await this.board.readMemoryCore(agent.name);
    const charter = await this.board.readRole(agent.role);
    const onboarding: OnboardingContext | null =
      dispatch.onboarding || newSession
        ? {
            agentName: agent.name,
            roleSummary: charter.purpose,
            project: dispatch.project,
            worktree,
          }
        : null;
    const instructions = renderInstructions({
      agentName: agent.name,
      roleCharter,
      memoryCore,
      homeDir: spec.configHome,
      boardDir: spec.boardDir,
      ...(onboarding === null ? {} : { onboarding }),
    });
    await this.renderConfigHome(agent.name, instructions);
    const prompt = buildTurnPrompt({
      dispatch,
      messages: inbox.messages,
      heldClaims: held,
      lastTurn,
      onboarding,
    });
    const token = this.board.issueTurnToken(
      agent.name,
      agent.role,
      this.turnTimeoutMs + 5 * 60_000,
    );

    const record: TurnRecord = { ...base, session };
    await this.board.beginTurn(record);
    this.log.info(
      { agent: agent.name, project: dispatch.project, session, newSession },
      "turn starting",
    );

    let result: TurnResult;
    const events: AgentEvent[] = [];
    try {
      result = await backend.runTurn(
        {
          spec,
          session,
          newSession,
          prompt,
          instructions,
          mcp: { url: this.mcpUrl, token },
          limits: { timeoutMs: this.turnTimeoutMs, maxTurns: this.maxTurns },
          statusSchema: turnStatusJsonSchema(),
          env: {
            GIT_AUTHOR_NAME: agent.name,
            GIT_AUTHOR_EMAIL: `${agent.name}@stellaris.local`,
            GIT_COMMITTER_NAME: agent.name,
            GIT_COMMITTER_EMAIL: `${agent.name}@stellaris.local`,
          },
        },
        (event) => {
          events.push(event);
          this.onEvent?.(agent.name, dispatch.project, event);
        },
      );
    } catch (error) {
      result = {
        events,
        finalText: "",
        usage: ZERO_USAGE,
        costUsd: 0,
        status: null,
        exitReason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // CLIs that assign their own session ids report the real one after the first turn.
    if (result.session !== undefined && result.session !== session) {
      await this.board.writeSession(agent.name, dispatch.project, agent.cli, result.session);
      session = result.session;
    }

    const finished: TurnRecord = {
      ...record,
      session,
      endedAt: this.now().toISOString(),
      exitReason: result.exitReason,
      status: result.status,
      error: result.error ?? null,
      usage: result.usage,
      costUsd: result.costUsd,
      toolCalls: result.events.filter((event) => event.type === "tool_call").length,
    };

    if (result.exitReason === "completed" || result.exitReason === "blocked") {
      // The digest was delivered; only now does the cursor move past it.
      await this.board.setInboxCursor(agent.name, inbox.cursor);
      await this.renewLeases(
        actor,
        held.map((task) => task.id),
      );
      if (result.status?.needsOwnerDecision === true) {
        await this.board.postMessage(actor, {
          channel: "decisions",
          body: `@${OWNER_NAME} decision needed on ${dispatch.project}: ${result.status.summary}`,
        });
      }
    }
    await this.board.finishTurn(finished);
    this.log.info(
      { agent: agent.name, project: dispatch.project, exitReason: finished.exitReason },
      "turn finished",
    );
    return finished;
  }

  /** Lands the claimer's branch on the default branch after a reviewer marks a task done. */
  async mergeTask(project: Name, taskId: Ulid): Promise<void> {
    const location = await this.board.findTask(taskId);
    const record = await this.board.readProject(project);
    const claimer = location.task.claimedBy;
    if (claimer === undefined) {
      await this.board.recordMerge(SYSTEM_ACTOR, {
        project,
        taskId,
        branch: "",
        ok: false,
        detail: "task has no claimer",
      });
      return;
    }
    const repoDir = await this.git.ensureRepo(record, this.board.paths.repo(project));
    const branch = `agent/${claimer}`;
    const outcome = await this.git.merge(repoDir, record.defaultBranch, branch);
    await this.board.recordMerge(SYSTEM_ACTOR, {
      project,
      taskId,
      branch,
      ok: outcome.ok,
      detail: outcome.detail,
    });
    const channel = `${project}/general`;
    if (outcome.ok) {
      await this.board.postMessage(SYSTEM_ACTOR, {
        channel,
        body: `Merged ${branch} for task ${taskId}: ${outcome.detail}`,
      });
    } else {
      await this.board.postMessage(SYSTEM_ACTOR, {
        channel,
        body: `@${claimer} the merge of ${branch} for task ${taskId} failed: ${outcome.detail}. Rebase on ${record.defaultBranch} and resubmit.`,
      });
    }
  }

  private async renewLeases(actor: Actor, taskIds: readonly Ulid[]): Promise<void> {
    for (const taskId of taskIds) {
      try {
        await this.board.claimTask(actor, { task_id: taskId });
      } catch {
        // The agent released or submitted the task during the turn; nothing to renew.
      }
    }
  }

  private async fail(base: TurnRecord, error: string): Promise<TurnRecord> {
    const record: TurnRecord = {
      ...base,
      endedAt: this.now().toISOString(),
      exitReason: "error",
      error,
    };
    await this.board.beginTurn(base);
    await this.board.finishTurn(record);
    this.log.error({ agent: base.agent, project: base.project, error }, "turn could not start");
    return record;
  }

  /** Writes the CLI config files into the agent's home for inspection and for CLIs driven without an SDK. */
  private async renderConfigHome(agent: Name, instructions: string): Promise<void> {
    const home = this.board.paths.agent(agent);
    const claudeDir = path.join(home, ".claude");
    const codexDir = path.join(home, ".codex");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    await writeFile(path.join(claudeDir, "CLAUDE.md"), instructions, "utf8");
    await writeFile(
      path.join(claudeDir, "board.mcp.json"),
      `${JSON.stringify(renderClaudeMcpConfig(this.mcpUrl), null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(codexDir, "AGENTS.md"), instructions, "utf8");
    await writeFile(
      path.join(codexDir, "board.mcp.toml"),
      renderCodexMcpConfig(this.mcpUrl),
      "utf8",
    );
  }
}
