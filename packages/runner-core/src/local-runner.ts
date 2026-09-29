import { writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { SYSTEM_ACTOR, type Actor, type Board } from "@stellaris/board-core";
import {
  USER_NAME,
  SOCIETY_SCOPE,
  turnStatusJsonSchema,
  type AgentEvent,
  type CliKind,
  type Name,
  type TurnDispatch,
  type TurnRecord,
  type Ulid,
} from "@stellaris/shared";
import { ExecaGit, type GitOps } from "./git.js";
import { buildTurnPrompt, type KnowledgeView, type SocietyView } from "./prompt.js";
import {
  renderClaudeMcpConfig,
  renderCodexMcpConfig,
  renderInstructions,
  type OnboardingContext,
} from "./render.js";
import {
  ZERO_USAGE,
  type AgentBackend,
  type AgentSpec,
  type ResidentSession,
  type TurnResult,
} from "./types.js";

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
  readonly runnerName: Name;
  readonly turnTimeoutMs?: number | undefined;
  readonly maxTurns?: number | undefined;
  /** How long a resident session stays warm after its last turn before the runner lets it go cold. */
  readonly residentIdleMs?: number | undefined;
  readonly git?: GitOps | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: RunnerLog | undefined;
  readonly onEvent?: ((agent: Name, project: Name, event: AgentEvent) => void) | undefined;
}

const SILENT: RunnerLog = { info() {}, warn() {}, error() {} };
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_RESIDENT_IDLE_MS = 10 * 60_000;
const USER_POST_TRIGGER = "user_post";

interface Resident {
  readonly session: ResidentSession;
  readonly token: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The embedded runner: ensures the worktree, renders the config home, builds the prompt,
 * runs the turn through the CLI's adapter, then records the outcome on the board.
 * Resident roles keep a warm session between turns; the society scope runs a turn in the
 * agent's home, outside any project.
 */
export class LocalRunner {
  private readonly board: Board;
  private readonly backends: Partial<Record<CliKind, AgentBackend>>;
  private readonly mcpUrl: string;
  private readonly runnerName: Name;
  private readonly turnTimeoutMs: number;
  private readonly maxTurns: number;
  private readonly residentIdleMs: number;
  private readonly git: GitOps;
  private readonly now: () => Date;
  private readonly log: RunnerLog;
  private readonly onEvent: ((agent: Name, project: Name, event: AgentEvent) => void) | undefined;
  private readonly prepareLocks = new Map<Name, Promise<void>>();
  private readonly residents = new Map<string, Resident>();

  constructor(options: LocalRunnerOptions) {
    this.board = options.board;
    this.backends = options.backends;
    this.mcpUrl = options.mcpUrl;
    this.runnerName = options.runnerName;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.residentIdleMs = options.residentIdleMs ?? DEFAULT_RESIDENT_IDLE_MS;
    this.git = options.git ?? new ExecaGit();
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? SILENT;
    this.onEvent = options.onEvent;
  }

  /** Agent-scope pairs with a warm session right now, as `agent/scope`. */
  get residentPairs(): string[] {
    return [...this.residents.keys()].toSorted();
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
      model: agent.model ?? null,
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
    const charter = await this.board.readRole(agent.role);
    const societyScope = dispatch.project === SOCIETY_SCOPE;
    if (societyScope && !charter.societyScope) {
      return this.fail(base, `${agent.role} cannot take society-scope turns`);
    }

    // The society scope has no repository: the agent's home is its working directory.
    const home = this.board.paths.agent(agent.name);
    const { worktree, repoDir } = societyScope
      ? { worktree: home, repoDir: home }
      : await this.prepare(agent.name, dispatch.project);
    const sessions = await this.board.readSessions(agent.name, dispatch.project);
    const spec: AgentSpec = {
      agent: agent.name,
      project: dispatch.project,
      cli: agent.cli,
      runner: this.runnerName,
      cwd: worktree,
      repoDir,
      configHome: home,
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
      norms: await this.board.readSocietyNorms(),
      skills: [
        ...(await this.board.listAgentSkills(agent.name)),
        ...(await this.board.listSocietySkills()),
      ],
      ...(onboarding === null ? {} : { onboarding }),
    });
    await this.renderConfigHome(agent.name, instructions);
    // Roles that route for the user get the roster and the project list in every digest.
    const societyView: SocietyView | null = charter.wakeTriggers.includes(USER_POST_TRIGGER)
      ? { projects: await this.board.listProjects(), members: await this.board.listMembers() }
      : null;
    const knowledge: KnowledgeView = societyScope
      ? { dir: this.board.paths.societyKnowledge(), topics: await this.board.listKnowledge(null) }
      : {
          dir: this.board.paths.projectKnowledge(dispatch.project),
          topics: await this.board.listKnowledge(dispatch.project),
        };
    const prompt = buildTurnPrompt({
      dispatch,
      messages: inbox.messages,
      heldClaims: held,
      lastTurn,
      onboarding,
      societyView,
      knowledge,
    });
    const env = {
      GIT_AUTHOR_NAME: agent.name,
      GIT_AUTHOR_EMAIL: `${agent.name}@stellaris.local`,
      GIT_COMMITTER_NAME: agent.name,
      GIT_COMMITTER_EMAIL: `${agent.name}@stellaris.local`,
    };
    const limits = { timeoutMs: this.turnTimeoutMs, maxTurns: this.maxTurns };
    const statusSchema = turnStatusJsonSchema();

    const record: TurnRecord = { ...base, session };
    await this.board.beginTurn(record);
    const resident = charter.resident && backend.startResident !== undefined;
    this.log.info(
      { agent: agent.name, project: dispatch.project, session, newSession, resident },
      "turn starting",
    );

    const events: AgentEvent[] = [];
    const onEvent = (event: AgentEvent): void => {
      events.push(event);
      this.onEvent?.(agent.name, dispatch.project, event);
    };
    let result: TurnResult;
    try {
      if (resident && backend.startResident !== undefined) {
        result = await this.runResidentTurn(backend, spec, {
          key: `${agent.name}/${dispatch.project}`,
          agent: { name: agent.name, role: agent.role },
          session,
          newSession,
          instructions,
          prompt,
          limits,
          statusSchema,
          env,
          onEvent,
        });
      } else {
        const token = this.board.issueTurnToken(
          agent.name,
          agent.role,
          this.turnTimeoutMs + 5 * 60_000,
        );
        result = await backend.runTurn(
          {
            spec,
            session,
            newSession,
            prompt,
            instructions,
            mcp: { url: this.mcpUrl, token },
            limits,
            statusSchema,
            env,
          },
          onEvent,
        );
      }
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
      model: result.model ?? agent.model ?? null,
    };

    if (result.exitReason === "completed" || result.exitReason === "blocked") {
      // The digest was delivered; only now does the cursor move past it.
      await this.board.setInboxCursor(agent.name, inbox.cursor);
      await this.renewLeases(
        actor,
        held.map((task) => task.id),
      );
      if (result.status?.needsUserDecision === true) {
        await this.board.postMessage(actor, {
          channel: "decisions",
          body: `@${USER_NAME} decision needed on ${dispatch.project}: ${result.status.summary}`,
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

  /**
   * One turn on a warm session: start it on first use, extend its token, run the prompt, then
   * either keep it warm until the idle timeout or recycle it when its instructions went stale.
   */
  private async runResidentTurn(
    backend: AgentBackend,
    spec: AgentSpec,
    input: {
      key: string;
      agent: { name: Name; role: Name };
      session: string;
      newSession: boolean;
      instructions: string;
      prompt: string;
      limits: { timeoutMs: number; maxTurns: number };
      statusSchema: Record<string, unknown>;
      env: Readonly<Record<string, string>>;
      onEvent: (event: AgentEvent) => void;
    },
  ): Promise<TurnResult> {
    if (backend.startResident === undefined) {
      throw new Error("backend cannot host resident sessions");
    }
    const ttl = this.residentIdleMs + this.turnTimeoutMs + 60_000;
    let resident = this.residents.get(input.key);
    if (resident === undefined) {
      const token = this.board.issueTurnToken(input.agent.name, input.agent.role, ttl);
      const session = await backend.startResident(spec, {
        session: input.session,
        newSession: input.newSession,
        instructions: input.instructions,
        mcp: { url: this.mcpUrl, token },
        limits: input.limits,
        statusSchema: input.statusSchema,
        env: input.env,
      });
      resident = { session, token, timer: null };
      this.residents.set(input.key, resident);
      this.log.info({ pair: input.key, session: session.session }, "resident session started");
    } else {
      this.board.extendTurnToken(resident.token, ttl);
    }
    if (resident.timer !== null) {
      clearTimeout(resident.timer);
      resident.timer = null;
    }
    const result = await resident.session.runTurn(input.prompt, input.onEvent);
    const stale = result.status?.memoryUpdated === true || result.exitReason !== "completed";
    if (stale) {
      // The instructions carry the memory core; a changed memory or a broken turn means a fresh start next time.
      await this.closeResident(input.key, "instructions changed or turn failed");
    } else {
      const active = resident;
      active.timer = setTimeout(() => {
        void this.closeResident(input.key, "idle");
      }, this.residentIdleMs);
      active.timer.unref?.();
    }
    return { ...result, session: resident.session.session };
  }

  private async closeResident(key: string, reason: string): Promise<void> {
    const resident = this.residents.get(key);
    if (resident === undefined) {
      return;
    }
    this.residents.delete(key);
    if (resident.timer !== null) {
      clearTimeout(resident.timer);
    }
    this.board.revokeTurnToken(resident.token);
    try {
      await resident.session.close();
    } catch (error) {
      this.log.warn({ pair: key, error: String(error) }, "resident session did not close cleanly");
    }
    this.log.info({ pair: key, reason }, "resident session closed");
  }

  /** Lets every warm session go: called on shutdown. */
  async close(): Promise<void> {
    await Promise.all([...this.residents.keys()].map((key) => this.closeResident(key, "shutdown")));
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
