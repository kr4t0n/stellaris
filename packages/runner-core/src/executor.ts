import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CliKindSchema,
  PATH_TOKENS,
  turnStatusJsonSchema,
  type AgentEvent,
  type CliKind,
  type LandRequest,
  type MergeOutcome,
  type ModelOption,
  type Name,
  type TurnJob,
  type TurnOutcome,
  type TurnWork,
} from "@stellaris/shared";
import { renderClaudeMcpConfig, renderCodexMcpConfig } from "./config-home.js";
import { ExecaGit, taskBranch, type GitOps } from "./git.js";
import type { RunnerLayout } from "./layout.js";
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

export interface TurnExecutorOptions {
  readonly layout: RunnerLayout;
  readonly backends: Partial<Record<CliKind, AgentBackend>>;
  /** The runner's name, which adapters stamp on `turn_started`; known once the server welcomes it. */
  readonly runnerName: () => Name;
  readonly git?: GitOps | undefined;
  readonly log?: RunnerLog | undefined;
  /** Called whenever the set of warm sessions changes, with their keys. */
  readonly onWarmChanged?: ((keys: string[]) => void) | undefined;
}

/** Where a turn runs: the working directory, the repository, and what to hand the worktree back to. */
interface Workspace {
  readonly cwd: string;
  readonly repoDir: string;
  /** For a project worktree, the agent's own branch; for a task's, null to detach; for a home, none. */
  readonly handBack: { readonly to: string | null } | null;
  readonly taskBranch: string | null;
}

interface Resident {
  readonly session: ResidentSession;
  readonly token: string;
  /** The model the session started with; a citizen given another model gets a fresh session. */
  readonly model: string | undefined;
  timer: ReturnType<typeof setTimeout> | null;
}

const SILENT: RunnerLog = { info() {}, warn() {}, error() {} };

/**
 * Runs turn jobs on this machine: makes sure of the project's repository and the turn's worktree,
 * fills the job's path tokens with this runner's paths, renders the CLI config files, runs the
 * turn through the CLI's adapter, cold or on a warm session, and hands the worktree back. It also
 * lands tasks in the repositories that live here and lists a CLI's models.
 */
export class TurnExecutor {
  private readonly layout: RunnerLayout;
  private readonly backends: Partial<Record<CliKind, AgentBackend>>;
  private readonly runnerName: () => Name;
  private readonly git: GitOps;
  private readonly log: RunnerLog;
  private readonly onWarmChanged: ((keys: string[]) => void) | undefined;
  private readonly projectLocks = new Map<Name, Promise<void>>();
  private readonly residents = new Map<string, Resident>();

  constructor(options: TurnExecutorOptions) {
    this.layout = options.layout;
    this.backends = options.backends;
    this.runnerName = options.runnerName;
    this.git = options.git ?? new ExecaGit();
    this.log = options.log ?? SILENT;
    this.onWarmChanged = options.onWarmChanged;
  }

  /** The CLIs this runner has an adapter for, and those that can keep a session warm. */
  get clis(): { all: CliKind[]; resident: CliKind[] } {
    const all = CliKindSchema.options.filter((cli) => this.backends[cli] !== undefined);
    return { all, resident: all.filter((cli) => this.backends[cli]?.startResident !== undefined) };
  }

  /** Conversations with a warm session right now, as session keys. */
  get warmKeys(): string[] {
    return [...this.residents.keys()].toSorted();
  }

  async run(job: TurnJob, onEvent: (event: AgentEvent) => void): Promise<TurnOutcome> {
    const backend = this.backends[job.cli];
    const fallbackSession = job.session ?? "unstarted";
    if (backend === undefined) {
      return failed(fallbackSession, `no backend registered for ${job.cli}`);
    }
    const home = this.layout.agent(job.agent);
    await mkdir(home, { recursive: true });
    let workspace: Workspace;
    try {
      workspace = await this.prepare(job, home);
    } catch (error) {
      return failed(fallbackSession, `could not prepare the workspace: ${String(error)}`);
    }
    const spec: AgentSpec = {
      agent: job.agent,
      project: job.scope,
      cli: job.cli,
      runner: this.runnerName(),
      cwd: workspace.cwd,
      repoDir: workspace.repoDir,
      configHome: home,
      boardDir: this.layout.board,
      ...(job.model === undefined ? {} : { model: job.model }),
    };
    const fill = (text: string): string =>
      text
        .replaceAll(PATH_TOKENS.home, home)
        .replaceAll(PATH_TOKENS.board, this.layout.board)
        .replaceAll(PATH_TOKENS.worktree, workspace.cwd);
    const instructions = fill(job.instructions);
    const prompt = fill(job.prompt);
    await this.renderConfigHome(home, instructions, job.mcp.url);
    const newSession = job.session === null;
    const session = job.session ?? (await backend.newSession(spec));
    const env = {
      GIT_AUTHOR_NAME: job.agent,
      GIT_AUTHOR_EMAIL: `${job.agent}@stellaris.local`,
      GIT_COMMITTER_NAME: job.agent,
      GIT_COMMITTER_EMAIL: `${job.agent}@stellaris.local`,
    };
    const limits = { timeoutMs: job.limits.timeoutMs, maxTurns: job.limits.maxTurns };
    const statusSchema = turnStatusJsonSchema();
    this.log.info(
      { agent: job.agent, scope: job.scope, thread: job.thread, session, newSession },
      "turn starting",
    );

    const events: AgentEvent[] = [];
    const collect = (event: AgentEvent): void => {
      events.push(event);
      onEvent(event);
    };
    let result: TurnResult;
    try {
      if (job.resident !== undefined && backend.startResident !== undefined) {
        result = await this.runResident(backend, spec, job, {
          session,
          newSession,
          instructions,
          prompt,
          limits,
          statusSchema,
          env,
          onEvent: collect,
        });
      } else {
        result = await backend.runTurn(
          {
            spec,
            session,
            newSession,
            prompt,
            instructions,
            mcp: job.mcp,
            limits,
            statusSchema,
            env,
            costSoFarUsd: job.costSoFarUsd,
          },
          collect,
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
    const work = await this.handBack(job.agent, workspace);
    this.log.info(
      { agent: job.agent, scope: job.scope, thread: job.thread, exitReason: result.exitReason },
      "turn finished",
    );
    return {
      exitReason: result.exitReason,
      status: result.status,
      error: result.error ?? null,
      usage: result.usage,
      costUsd: result.costUsd,
      ...(result.sessionCostUsd === undefined ? {} : { sessionCostUsd: result.sessionCostUsd }),
      session: result.session ?? session,
      model: result.model ?? null,
      work,
    };
  }

  /** A task's own worktree goes once its task has ended; its work is on the task's branch. */
  async dropTaskWorktree(job: TurnJob): Promise<void> {
    const { workspace } = job;
    if (workspace.kind !== "task") {
      return;
    }
    try {
      await this.withProjectLock(workspace.repo.slug, () =>
        this.git.removeWorktree(
          this.layout.repo(workspace.repo.slug),
          this.layout.taskWorktree(job.agent, workspace.taskId),
        ),
      );
    } catch (error) {
      this.log.warn(
        { taskId: workspace.taskId, error: String(error) },
        "could not remove an ended task's worktree",
      );
    }
  }

  /** Lands a task: merges its branch into the default branch of the project's repository here. */
  async land(request: LandRequest): Promise<MergeOutcome> {
    return this.withProjectLock(request.repo.slug, async () => {
      const repoDir = await this.git.ensureRepo(request.repo, this.layout.repo(request.repo.slug));
      if (!(await this.git.branchExists(repoDir, request.branch))) {
        return { ok: true, detail: "nothing to land, since the task left no branch" };
      }
      return this.git.merge(repoDir, request.repo.defaultBranch, request.branch);
    });
  }

  async models(cli: CliKind): Promise<ModelOption[]> {
    const backend = this.backends[cli];
    return backend?.listModels === undefined ? [] : backend.listModels();
  }

  /** Lets every warm session go: called on shutdown. */
  async close(): Promise<void> {
    await Promise.all([...this.residents.keys()].map((key) => this.closeResident(key, "shutdown")));
  }

  /**
   * Makes sure of the project's repository and the worktree a turn runs in: the pair's own for its
   * home conversation and its proposal and topic threads, or, for a task's conversation, one of its
   * own on the task's branch. A society-scope turn runs in the agent's home.
   */
  private async prepare(job: TurnJob, home: string): Promise<Workspace> {
    const { workspace } = job;
    if (workspace.kind === "home") {
      return { cwd: home, repoDir: home, handBack: null, taskBranch: null };
    }
    const { repo } = workspace;
    return this.withProjectLock(repo.slug, async () => {
      const repoDir = await this.git.ensureRepo(repo, this.layout.repo(repo.slug));
      if (workspace.kind === "task") {
        const branch = taskBranch(workspace.taskId);
        await this.git.ensureBranch(repoDir, branch, repo.defaultBranch);
        const cwd = await this.git.ensureTaskWorktree(
          repoDir,
          this.layout.taskWorktree(job.agent, workspace.taskId),
          branch,
        );
        return { cwd, repoDir, handBack: { to: null }, taskBranch: branch };
      }
      const own = `agent/${job.agent}`;
      const cwd = await this.git.ensureWorktree(
        repoDir,
        this.layout.worktree(job.agent, repo.slug),
        own,
        repo.defaultBranch,
      );
      // Every task in play gets its branch before the turn, so a holder only has to switch to it.
      for (const branch of workspace.branches) {
        await this.git.ensureBranch(repoDir, branch, repo.defaultBranch);
      }
      return { cwd, repoDir, handBack: { to: own }, taskBranch: null };
    });
  }

  /**
   * Commits what the turn left on a task branch and returns the worktree to the agent's own
   * branch, or for a task's own worktree detaches it, which frees the branch for the next holder.
   * Reports the task branch the turn left work on, with its commit.
   */
  private async handBack(agent: Name, workspace: Workspace): Promise<TurnWork | null> {
    if (workspace.handBack === null) {
      return null;
    }
    try {
      const handed = await this.git.handBack(workspace.cwd, workspace.handBack.to, {
        name: agent,
        email: `${agent}@stellaris.local`,
      });
      if (handed?.committed === true) {
        this.log.info({ agent, branch: handed.branch }, "committed work left at the end of a turn");
      }
      const branch = handed?.branch ?? workspace.taskBranch;
      if (branch === null) {
        return null;
      }
      const head = await this.git.head(workspace.repoDir, branch);
      return head === null ? null : { branch, head };
    } catch (error) {
      this.log.warn({ agent, error: String(error) }, "could not hand the worktree back");
      return null;
    }
  }

  /**
   * One turn on a warm session: start it on first use, run the prompt, then either keep it warm
   * until the idle timeout or recycle it when its instructions went stale. A session given another
   * token or model than it started with starts afresh, since the CLI read both at its start.
   */
  private async runResident(
    backend: AgentBackend,
    spec: AgentSpec,
    job: TurnJob,
    input: {
      session: string;
      newSession: boolean;
      instructions: string;
      prompt: string;
      limits: { timeoutMs: number | null; maxTurns: number | null };
      statusSchema: Record<string, unknown>;
      env: Readonly<Record<string, string>>;
      onEvent: (event: AgentEvent) => void;
    },
  ): Promise<TurnResult> {
    const resident = job.resident;
    if (backend.startResident === undefined || resident === undefined) {
      throw new Error("backend cannot host resident sessions");
    }
    const warm = this.residents.get(resident.key);
    if (warm !== undefined && (warm.model !== spec.model || warm.token !== job.mcp.token)) {
      await this.closeResident(resident.key, "model or token changed");
    }
    let current = this.residents.get(resident.key);
    if (current === undefined) {
      const session = await backend.startResident(spec, {
        session: input.session,
        newSession: input.newSession,
        instructions: input.instructions,
        mcp: job.mcp,
        limits: input.limits,
        statusSchema: input.statusSchema,
        env: input.env,
        costSoFarUsd: job.costSoFarUsd,
      });
      current = { session, token: job.mcp.token, model: spec.model, timer: null };
      this.residents.set(resident.key, current);
      this.log.info({ pair: resident.key, session: session.session }, "resident session started");
      this.onWarmChanged?.(this.warmKeys);
    }
    if (current.timer !== null) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    const result = await current.session.runTurn(input.prompt, input.onEvent);
    const stale = result.status?.memoryUpdated === true || result.exitReason !== "completed";
    if (stale) {
      // The instructions carry the memory core; a changed memory or a broken turn means a fresh start next time.
      await this.closeResident(resident.key, "instructions changed or turn failed");
    } else {
      const active = current;
      active.timer = setTimeout(() => {
        void this.closeResident(resident.key, "idle");
      }, resident.idleMs);
      active.timer.unref?.();
    }
    return { ...result, session: current.session.session };
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
    try {
      await resident.session.close();
    } catch (error) {
      this.log.warn({ pair: key, error: String(error) }, "resident session did not close cleanly");
    }
    this.log.info({ pair: key, reason }, "resident session closed");
    this.onWarmChanged?.(this.warmKeys);
  }

  /**
   * Runs `work` alone among git work on the project's repository. Two first turns once both
   * initialized the same repository, and two turns of one citizen, its home and a task's, once both
   * created the task's branch, and the second failed.
   */
  private async withProjectLock<T>(project: Name, work: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(project) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.projectLocks.set(
      project,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Writes the CLI config files into the agent's home copy, for inspection and for CLIs driven without an SDK. */
  private async renderConfigHome(
    home: string,
    instructions: string,
    mcpUrl: string,
  ): Promise<void> {
    const claudeDir = path.join(home, ".claude");
    const codexDir = path.join(home, ".codex");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    await writeFile(path.join(claudeDir, "CLAUDE.md"), instructions, "utf8");
    await writeFile(
      path.join(claudeDir, "board.mcp.json"),
      `${JSON.stringify(renderClaudeMcpConfig(mcpUrl), null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(codexDir, "AGENTS.md"), instructions, "utf8");
    await writeFile(path.join(codexDir, "board.mcp.toml"), renderCodexMcpConfig(mcpUrl), "utf8");
  }
}

/** The outcome of a turn that never reached its CLI. */
function failed(session: string, error: string): TurnOutcome {
  return {
    exitReason: "error",
    status: null,
    error,
    usage: ZERO_USAGE,
    costUsd: 0,
    session,
    model: null,
    work: null,
  };
}
