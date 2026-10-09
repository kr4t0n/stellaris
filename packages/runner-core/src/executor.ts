import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BRANCH_CHANGES_LIMIT,
  BRANCH_FILE_LIMIT_BYTES,
  CliKindSchema,
  HeldWorkspaceSchema,
  HOME_SCRATCH,
  PATH_TOKENS,
  SERVER_TOKEN,
  SOCIETY_SCOPE,
  sameConversation,
  turnStatusJsonSchema,
  WORKSPACE_TOKEN,
  type AgentEvent,
  type BranchChanges,
  type BranchChangesRead,
  type BranchFile,
  type BranchRead,
  type CliKind,
  type HeldWorkspace,
  type LandRequest,
  type MergeOutcome,
  type ModelOption,
  type Name,
  type ProjectRepo,
  type SweepResult,
  type TurnJob,
  type TurnOutcome,
  type TurnWork,
  type WorkspaceConversation,
} from "@stellaris/shared";
import { renderClaudeMcpConfig, renderCodexMcpConfig } from "./config-home.js";
import { TurnControl } from "./control.js";
import { ExecaGit, taskBranch, type GitOps, type RemoteSync } from "./git.js";
import type { RunnerLayout } from "./layout.js";
import {
  ZERO_USAGE,
  type AgentBackend,
  type AgentSpec,
  type ResidentSession,
  type TurnResult,
} from "./types.js";
import { holdsLeftovers, renderWorkspaceReport, type WorkspaceReport } from "./workspace-report.js";

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
  /** Where this runner reaches the board server, which a job's `SERVER_TOKEN` stands for. */
  readonly serverUrl: string;
  /** How often a project's remote is fetched at most; a minute unless set. */
  readonly fetchIntervalMs?: number | undefined;
}

/** The most entries a list in a workspace report shows. */
const LISTED = 10;
const FETCH_INTERVAL_MS = 60_000;

/** Where a turn runs: the working directory, the repository, and what to hand the worktree back to. */
interface Workspace {
  readonly cwd: string;
  readonly repoDir: string;
  /** For the pair's worktree, the agent's own branch; for a task's or a thread's, null to detach; for a home, none. */
  readonly handBack: { readonly to: string | null } | null;
  readonly taskBranch: string | null;
  /** What the prompt says of the workspace, or null outside projects. */
  readonly report: WorkspaceReport | null;
  /** Whether the workspace is its conversation's own, a task's, a thread's, or a channel's. */
  readonly own: boolean;
}

/** A conversation's workspace on this runner, and the project whose repository it belongs to. */
interface Found {
  readonly held: HeldWorkspace;
  readonly dir: string;
  readonly repo: Name | null;
}

async function dirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

interface Resident {
  readonly session: ResidentSession;
  readonly token: string;
  /** The model the session started with; a citizen given another model gets a fresh session. */
  readonly model: string | undefined;
  /** The effort the session started with, which it keeps for good, as it does its model. */
  readonly effort: string | undefined;
  timer: ReturnType<typeof setTimeout> | null;
}

const SILENT: RunnerLog = { info() {}, warn() {}, error() {} };

/**
 * Runs turn jobs on this machine: makes sure of the project's repository and the turn's worktree,
 * fills the job's path tokens with this runner's paths and its server token with this runner's
 * address for the server, renders the CLI config files, runs the turn through the CLI's adapter,
 * cold or on a warm session, and hands the worktree back. It also lands tasks in the repositories
 * that live here, reads files from their branches, and lists a CLI's models.
 */
export class TurnExecutor {
  private readonly layout: RunnerLayout;
  private readonly backends: Partial<Record<CliKind, AgentBackend>>;
  private readonly runnerName: () => Name;
  private readonly git: GitOps;
  private readonly log: RunnerLog;
  private readonly onWarmChanged: ((keys: string[]) => void) | undefined;
  private readonly serverUrl: string;
  private readonly projectLocks = new Map<Name, Promise<void>>();
  private readonly residents = new Map<string, Resident>();
  private readonly fetchIntervalMs: number;
  /** When each project's remote was last fetched, and why the last fetch failed, if it did. */
  private readonly fetched = new Map<Name, { at: number; error?: string | undefined }>();

  constructor(options: TurnExecutorOptions) {
    this.layout = options.layout;
    this.backends = options.backends;
    this.runnerName = options.runnerName;
    this.git = options.git ?? new ExecaGit();
    this.log = options.log ?? SILENT;
    this.onWarmChanged = options.onWarmChanged;
    this.serverUrl = options.serverUrl;
    this.fetchIntervalMs = options.fetchIntervalMs ?? FETCH_INTERVAL_MS;
  }

  /**
   * The CLIs this runner has an adapter for, those that can keep a session warm, and those whose
   * running turns take steers and stops.
   */
  get clis(): { all: CliKind[]; resident: CliKind[]; steerable: CliKind[]; stoppable: CliKind[] } {
    const all = CliKindSchema.options.filter((cli) => this.backends[cli] !== undefined);
    return {
      all,
      resident: all.filter((cli) => this.backends[cli]?.startResident !== undefined),
      steerable: all.filter((cli) => this.backends[cli]?.steers === true),
      stoppable: all.filter((cli) => this.backends[cli]?.stops === true),
    };
  }

  /** Conversations with a warm session right now, as session keys. */
  get warmKeys(): string[] {
    return [...this.residents.keys()].toSorted();
  }

  async run(
    received: TurnJob,
    onEvent: (event: AgentEvent) => void,
    control: TurnControl = new TurnControl(),
  ): Promise<TurnOutcome> {
    const job: TurnJob = {
      ...received,
      mcp: { ...received.mcp, url: received.mcp.url.replaceAll(SERVER_TOKEN, this.serverUrl) },
    };
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
    const report = workspace.report === null ? "" : renderWorkspaceReport(workspace.report);
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
      ...(job.effort === undefined ? {} : { effort: job.effort }),
    };
    const fill = (text: string): string =>
      text
        .replaceAll(PATH_TOKENS.home, home)
        .replaceAll(PATH_TOKENS.board, this.layout.board)
        .replaceAll(PATH_TOKENS.worktree, workspace.cwd)
        .replaceAll(WORKSPACE_TOKEN, report);
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
      {
        agent: job.agent,
        scope: job.scope,
        thread: job.thread,
        channel: job.channel,
        session,
        newSession,
      },
      "turn starting",
    );

    const events: AgentEvent[] = [];
    const collect = (event: AgentEvent): void => {
      events.push(event);
      onEvent(event);
    };
    let result: TurnResult;
    try {
      if (control.stopped) {
        // Stopped while its workspace was being prepared: the CLI never starts.
        result = { ...stoppedResult(events), session };
      } else if (job.resident !== undefined && backend.startResident !== undefined) {
        result = await this.runResident(backend, spec, job, {
          session,
          newSession,
          instructions,
          prompt,
          limits,
          statusSchema,
          env,
          onEvent: collect,
          control,
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
          control,
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
    // A turn the user stopped ended because of it, however its CLI reported the end.
    if (control.stopped && result.exitReason !== "completed") {
      result = { ...result, exitReason: "stopped" };
    }
    const work = await this.handBack(job.agent, workspace);
    const leftovers = workspace.own && (await this.leftoversIn(workspace.cwd));
    this.log.info(
      {
        agent: job.agent,
        scope: job.scope,
        thread: job.thread,
        channel: job.channel,
        exitReason: result.exitReason,
      },
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
      leftovers,
    };
  }

  /** Whether a worktree holds work no branch does; unreadable counts as nothing. */
  private async leftoversIn(worktree: string): Promise<boolean> {
    try {
      return holdsLeftovers(await this.git.worktreeState(worktree));
    } catch {
      return false;
    }
  }

  /** The conversations' workspaces this runner holds, which it reports when its stream opens. */
  async held(): Promise<HeldWorkspace[]> {
    return (await this.findHeld()).map((found) => found.held);
  }

  /**
   * Removes every citizen's workspace for a conversation that ended, but those a turn still uses,
   * which its end removes, and those holding work on no branch, which are kept for a closing turn.
   */
  async sweep(
    conversation: WorkspaceConversation,
    busy: (held: HeldWorkspace) => boolean,
  ): Promise<SweepResult> {
    const kept: HeldWorkspace[] = [];
    for (const found of await this.findHeld()) {
      if (!sameConversation(found.held.conversation, conversation) || busy(found.held)) {
        continue;
      }
      const { repo } = found;
      if (repo === null) {
        // A scratch folder is never kept, as the turn contract says.
        await rm(found.dir, { recursive: true, force: true });
        continue;
      }
      const keep = await this.withProjectLock(repo, async () => {
        if (holdsLeftovers(await this.git.worktreeState(found.dir))) {
          return true;
        }
        await this.git.removeWorktree(this.layout.repo(repo), found.dir);
        return false;
      });
      if (keep) {
        kept.push(found.held);
      }
    }
    if (kept.length > 0) {
      this.log.info({ conversation, kept: kept.map((each) => each.agent) }, "kept workspaces");
    }
    return { kept };
  }

  /**
   * Every conversation's own workspace here: tasks', threads', and channels' worktrees, and the
   * folders of threads and channels outside projects in the homes' scratch folders.
   */
  private async findHeld(): Promise<Found[]> {
    const found: Found[] = [];
    const add = (held: HeldWorkspace, dir: string, repo: Name | null): void => {
      const parsed = HeldWorkspaceSchema.safeParse(held);
      if (parsed.success) {
        found.push({ held: parsed.data, dir, repo });
      }
    };
    const worktrees = path.join(this.layout.root, "worktrees");
    for (const agent of await dirs(worktrees)) {
      const mine = path.join(worktrees, agent);
      for (const kind of [".tasks", ".threads"]) {
        for (const id of await dirs(path.join(mine, kind))) {
          const dir = path.join(mine, kind, id);
          const repo = await this.repoOf(dir);
          if (repo !== null) {
            add({ agent, scope: repo, conversation: { kind: "thread", id } }, dir, repo);
          }
        }
      }
      for (const slug of await dirs(path.join(mine, ".channels"))) {
        for (const name of await dirs(path.join(mine, ".channels", slug))) {
          const dir = path.join(mine, ".channels", slug, name);
          add(
            { agent, scope: slug, conversation: { kind: "channel", scope: slug, name } },
            dir,
            slug,
          );
        }
      }
    }
    const agents = path.join(this.layout.root, "agents");
    for (const agent of await dirs(agents)) {
      const scratch = path.join(agents, agent, HOME_SCRATCH);
      for (const id of await dirs(path.join(scratch, ".threads"))) {
        add(
          { agent, scope: SOCIETY_SCOPE, conversation: { kind: "thread", id } },
          path.join(scratch, ".threads", id),
          null,
        );
      }
      for (const name of await dirs(path.join(scratch, ".channels"))) {
        add(
          {
            agent,
            scope: SOCIETY_SCOPE,
            conversation: { kind: "channel", scope: SOCIETY_SCOPE, name },
          },
          path.join(scratch, ".channels", name),
          null,
        );
      }
    }
    return found;
  }

  /** The project a worktree belongs to, from the repository its `.git` file points into. */
  private async repoOf(worktree: string): Promise<Name | null> {
    try {
      const pointer = (await readFile(path.join(worktree, ".git"), "utf8")).trim();
      const gitdir = pointer.startsWith("gitdir: ") ? pointer.slice("gitdir: ".length) : null;
      if (gitdir === null) {
        return null;
      }
      const repos = path.dirname(this.layout.repo("x"));
      const [slug] = path.relative(repos, path.resolve(worktree, gitdir)).split(path.sep);
      return slug === undefined || slug === ".." || slug === "" ? null : slug;
    } catch {
      return null;
    }
  }

  /**
   * Fetches the project's remote, at most once per interval, and fast-forwards the local branches
   * that follow it. A failed fetch is reported until a later one succeeds; nothing here fails a turn.
   */
  private async syncRemote(repoDir: string, repo: ProjectRepo): Promise<RemoteSync> {
    if (repo.origin === null) {
      return {};
    }
    const now = Date.now();
    const last = this.fetched.get(repo.slug);
    const fetch = last === undefined || now - last.at >= this.fetchIntervalMs;
    try {
      const sync = await this.git.syncRemote(repoDir, repo.defaultBranch, fetch);
      if (fetch) {
        this.fetched.set(repo.slug, { at: now, error: sync.fetchError });
      }
      const error = this.fetched.get(repo.slug)?.error;
      return { ...sync, ...(error === undefined ? {} : { fetchError: error }) };
    } catch (error) {
      this.log.warn({ project: repo.slug, error: String(error) }, "could not follow the remote");
      return {};
    }
  }

  /**
   * A conversation's own workspace goes once its task or thread has ended or its channel was
   * archived: a task's work is on its branch, and a thread's or a channel's was told to go
   * somewhere that lasts.
   */
  async dropWorkspace(job: TurnJob): Promise<void> {
    const { workspace } = job;
    try {
      if (workspace.kind === "home") {
        const scratch = this.ownScratch(job.agent, workspace);
        if (scratch !== null) {
          await rm(scratch, { recursive: true, force: true });
        }
        return;
      }
      const worktree =
        workspace.kind === "task"
          ? this.layout.taskWorktree(job.agent, workspace.taskId)
          : this.ownWorktree(job.agent, workspace);
      if (worktree !== null) {
        await this.withProjectLock(workspace.repo.slug, () =>
          this.git.removeWorktree(this.layout.repo(workspace.repo.slug), worktree),
        );
      }
    } catch (error) {
      this.log.warn(
        { agent: job.agent, thread: job.thread, channel: job.channel, error: String(error) },
        "could not remove an ended conversation's workspace",
      );
    }
  }

  /**
   * The folder of a thread's or a channel's conversation outside projects, under the home's
   * scratch folder, or null for the home conversation, which works in the scratch folder itself.
   */
  private ownScratch(
    agent: Name,
    workspace: { thread?: string | undefined; channel?: Name | undefined },
  ): string | null {
    const scratch = path.join(this.layout.agent(agent), HOME_SCRATCH);
    if (workspace.thread !== undefined) {
      return path.join(scratch, ".threads", workspace.thread);
    }
    return workspace.channel === undefined
      ? null
      : path.join(scratch, ".channels", workspace.channel);
  }

  /** The worktree of a thread's or a channel's conversation in a project, or null for the home's. */
  private ownWorktree(
    agent: Name,
    workspace: { repo: { slug: Name }; thread?: string | undefined; channel?: Name | undefined },
  ): string | null {
    if (workspace.thread !== undefined) {
      return this.layout.threadWorktree(agent, workspace.thread);
    }
    return workspace.channel === undefined
      ? null
      : this.layout.channelWorktree(agent, workspace.repo.slug, workspace.channel);
  }

  /** Lands a task: merges its branch into the default branch of the project's repository here. */
  async land(request: LandRequest): Promise<MergeOutcome> {
    return this.withProjectLock(request.repo.slug, async () => {
      const repoDir = await this.git.ensureRepo(request.repo, this.layout.repo(request.repo.slug));
      await this.git.ensureDefaultBranch(repoDir, request.repo);
      await this.syncRemote(repoDir, request.repo);
      if (!(await this.git.branchExists(repoDir, request.branch))) {
        return { ok: true, detail: "nothing to land, since the task left no branch" };
      }
      return this.git.merge(repoDir, request.repo.defaultBranch, request.branch);
    });
  }

  /**
   * One path on a branch of a project's repository here. Null when the project's repository is not
   * here, or the branch or the path does not exist; git would otherwise look for a repository
   * above the runner's data directory.
   */
  async readBranch(read: BranchRead): Promise<BranchFile | null> {
    const repoDir = await this.repoHere(read.repo.slug);
    return repoDir === null
      ? null
      : this.git.readBranch(repoDir, read.branch, read.path, BRANCH_FILE_LIMIT_BYTES);
  }

  /** What a branch of a project's repository here changed, or null when there is none. */
  async branchChanges(read: BranchChangesRead): Promise<BranchChanges | null> {
    const repoDir = await this.repoHere(read.repo.slug);
    if (repoDir === null) {
      return null;
    }
    // Counted from the default branch, which a project moved to another may not have here yet.
    await this.withProjectLock(read.repo.slug, () =>
      this.git.ensureDefaultBranch(repoDir, read.repo),
    );
    return this.git.branchChanges(
      repoDir,
      read.branch,
      read.repo.defaultBranch,
      BRANCH_CHANGES_LIMIT,
    );
  }

  /** A project's repository on this runner, or null when it has none. */
  private async repoHere(slug: Name): Promise<string | null> {
    try {
      await access(path.join(this.layout.repo(slug), ".git"));
      return this.layout.repo(slug);
    } catch {
      return null;
    }
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
   * home conversation; for a task's conversation, one of its own on the task's branch; for a
   * proposal's, a topic's, or a channel's, one of its own detached at the pair's branch. A
   * society-scope turn runs in the scratch folder of the agent's home, a thread's or a channel's
   * in a folder of its own there.
   */
  private async prepare(job: TurnJob, home: string): Promise<Workspace> {
    const { workspace } = job;
    if (workspace.kind === "home") {
      // Outside any project a turn works in its home's scratch folder, which is never committed,
      // so what its tools leave behind stays on this machine; memory and skills sit beside it.
      const cwd = this.ownScratch(job.agent, workspace) ?? path.join(home, HOME_SCRATCH);
      await mkdir(cwd, { recursive: true });
      return {
        cwd,
        repoDir: home,
        handBack: null,
        taskBranch: null,
        report: null,
        own: false,
      };
    }
    const { repo } = workspace;
    const base = repo.defaultBranch;
    return this.withProjectLock(repo.slug, async () => {
      const repoDir = await this.git.ensureRepo(repo, this.layout.repo(repo.slug));
      await this.git.ensureDefaultBranch(repoDir, repo);
      const remote = await this.syncRemote(repoDir, repo);
      if (workspace.kind === "task") {
        const branch = taskBranch(workspace.taskId);
        await this.git.ensureBranch(repoDir, branch, base);
        await this.git.followBase(repoDir, branch, base);
        const cwd = await this.git.ensureTaskWorktree(
          repoDir,
          this.layout.taskWorktree(job.agent, workspace.taskId),
          branch,
        );
        const report: WorkspaceReport = {
          defaultBranch: base,
          remote,
          worktree: {
            kind: "task",
            branch,
            state: await this.git.worktreeState(cwd),
            behind: await this.git.ahead(repoDir, branch, base, LISTED),
          },
        };
        return { cwd, repoDir, handBack: { to: null }, taskBranch: branch, report, own: true };
      }
      const own = `agent/${job.agent}`;
      const pairWorktree = await this.git.ensureWorktree(
        repoDir,
        this.layout.worktree(job.agent, repo.slug),
        own,
        base,
      );
      // Every task in play gets its branch before the turn, so a holder only has to switch to it,
      // and one nobody has worked on yet starts from the default branch as it is now.
      for (const branch of workspace.branches) {
        await this.git.ensureBranch(repoDir, branch, base);
        await this.git.followBase(repoDir, branch, base);
      }
      const ownWorktree = this.ownWorktree(job.agent, workspace);
      if (ownWorktree === null) {
        const before = await this.git.worktreeState(pairWorktree);
        const moved =
          before.branch === own && (await this.git.fastForwardWorktree(pairWorktree, base));
        const report: WorkspaceReport = {
          defaultBranch: base,
          remote,
          worktree: {
            kind: "home",
            branch: own,
            state: moved ? await this.git.worktreeState(pairWorktree) : before,
            ownCommits: (await this.git.ahead(repoDir, base, own, LISTED)).commits,
            moved,
            behind: await this.git.ahead(pairWorktree, "HEAD", base, LISTED),
          },
        };
        return {
          cwd: pairWorktree,
          repoDir,
          handBack: { to: own },
          taskBranch: null,
          report,
          own: false,
        };
      }
      const cwd = await this.git.ensureThreadWorktree(repoDir, ownWorktree, base);
      const moved = await this.git.refreshDetached(cwd, base);
      const report: WorkspaceReport = {
        defaultBranch: base,
        remote,
        worktree: {
          kind: "own",
          state: await this.git.worktreeState(cwd),
          moved,
          behind: await this.git.ahead(cwd, "HEAD", base, LISTED),
        },
      };
      return { cwd, repoDir, handBack: { to: null }, taskBranch: null, report, own: true };
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
      control: TurnControl;
    },
  ): Promise<TurnResult> {
    const resident = job.resident;
    if (backend.startResident === undefined || resident === undefined) {
      throw new Error("backend cannot host resident sessions");
    }
    const warm = this.residents.get(resident.key);
    if (
      warm !== undefined &&
      (warm.model !== spec.model || warm.effort !== spec.effort || warm.token !== job.mcp.token)
    ) {
      await this.closeResident(resident.key, "model, effort, or token changed");
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
      current = {
        session,
        token: job.mcp.token,
        model: spec.model,
        effort: spec.effort,
        timer: null,
      };
      this.residents.set(resident.key, current);
      this.log.info({ pair: resident.key, session: session.session }, "resident session started");
      this.onWarmChanged?.(this.warmKeys);
    }
    if (current.timer !== null) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    const result = await current.session.runTurn(input.prompt, input.onEvent, input.control);
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

/** A turn stopped before its CLI started. */
function stoppedResult(events: AgentEvent[]): TurnResult {
  return {
    events,
    finalText: "",
    usage: ZERO_USAGE,
    costUsd: 0,
    status: null,
    exitReason: "stopped",
  };
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
    leftovers: false,
  };
}
