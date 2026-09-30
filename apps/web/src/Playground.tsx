import { SOCIETY_SCOPE } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { asksOf, hasUnseenReply } from "./board/asks.js";
import { Navigator, type GovernanceView } from "./board/Navigator.js";
import { useNeedsYou } from "./board/useNeedsYou.js";
import { AskBox, AskHint } from "./components/AskBox.js";
import { CitizenCard } from "./components/CitizenCard.js";
import { EntityContext } from "./components/Entities.js";
import { Hud } from "./components/Hud.js";
import { Island } from "./components/Island.js";
import { LogsIsland } from "./components/LogsIsland.js";
import { TaskCard } from "./components/TaskCard.js";
import { ApiError } from "./lib/api.js";
import { entityIndex } from "./lib/entities.js";
import { followBoardEvents, refreshFor } from "./lib/events.js";
import { LiveContext, LiveStore } from "./lib/live.js";
import { useSeen } from "./lib/seen.js";
import {
  useAllTasks,
  useMembers,
  useNow,
  useProjects,
  useProposals,
  useScheduler,
  useSession,
  useSociety,
  useTask,
  useThreads,
} from "./lib/session.js";
import { skyModel } from "./sky/model.js";
import { Sky, type Insets } from "./sky/Sky.js";

const NO_INSETS: Insets = { left: 0, right: 0 };
const ISLAND_MARGIN = 16;
const NAVIGATOR_WIDTH = 256;

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = (): void => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

/** The part of a path after a prefix, when the path has that prefix. */
function after(pathname: string, prefix: string): string | null {
  return pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : null;
}

/**
 * The signed-in view and the root of every route: the sky of citizens, and when a board route is
 * open, the navigator island on the left and the content island on the right, the sky fitting
 * between them. The board's event stream keeps every read current, and the turn stream keeps the
 * live picture of what citizens are doing.
 */
export function Playground() {
  const { api, token, signOut } = useSession();
  const client = useQueryClient();
  useEffect(
    () =>
      followBoardEvents(token, {
        onEvent: (event) => refreshFor(client, event),
        onResume: () => void client.invalidateQueries(),
      }),
    [token, client],
  );
  const [live] = useState(() => new LiveStore());
  useEffect(() => live.follow(token), [live, token]);
  const society = useSociety();
  const members = useMembers();
  const projects = useProjects();
  const scheduler = useScheduler();
  const threads = useThreads();
  const tasks = useAllTasks();
  const proposals = useProposals();
  const entities = useMemo(
    () => entityIndex(threads.data ?? [], tasks, proposals.data ?? []),
    [threads.data, tasks, proposals.data],
  );
  const navigate = useNavigate();
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.setPaused(paused),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["scheduler"] }),
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [logsOpen, setLogsOpen] = useState(false);
  // The ask box shows only on the route it was opened on: its asks lead into the board.
  const [askAt, setAskAt] = useState<string | null>(null);
  const askOpen = askAt === pathname;
  const closeAsk = useCallback(() => setAskAt(null), []);
  // Whether focus last moved by pointer rather than Tab. Chromium matches :focus-visible on a
  // clicked button once any key is pressed, so it cannot tell a keyboard user's control apart.
  const pointerFocus = useRef(true);
  const seen = useSeen();
  const search = useSearch({ strict: false });
  // What is hovered: a star's id, since a citizen in turns in two projects has a star in each, or
  // `task:<id>` for a task's mark.
  const [hovered, setHovered] = useState<string | null>(null);
  const now = useNow(30_000);
  const width = useWindowWidth();

  const boardOpen = pathname !== "/";
  const contentWidth = Math.round(Math.min(680, Math.max(420, width * 0.4)));
  const insets = useMemo<Insets>(
    () =>
      boardOpen
        ? { left: NAVIGATOR_WIDTH + 2 * ISLAND_MARGIN, right: contentWidth + 2 * ISLAND_MARGIN }
        : NO_INSETS,
    [boardOpen, contentWidth],
  );
  // What the open route is about: a channel, directly or through a thread, or a project's tasks,
  // directly or through a task. The navigator highlights it and the sky focuses its project.
  const threadId = after(pathname, "/thread/");
  const task = useTask(after(pathname, "/task/"));
  const activeChannel =
    after(pathname, "/c/") ??
    (threadId === null
      ? null
      : (threads.data?.find((thread) => thread.id === threadId)?.channel ?? null));
  const tasksPath = /^\/p\/([^/]+)\/tasks$/.exec(pathname)?.[1];
  const activeTasks = tasksPath ?? task.data?.project ?? null;
  const activeCitizen = after(pathname, "/citizen/");
  // The citizen view's `scope` names a conversation: a scope, or `scope/thread`.
  const activeScope = activeCitizen === null ? null : (search.scope ?? null);
  const activePlace = activeScope?.split("/")[0] ?? null;
  const activeGovernance: GovernanceView | null =
    pathname === "/needs-you"
      ? "needs-you"
      : pathname === "/proposals" || pathname.startsWith("/proposal/")
        ? "proposals"
        : null;
  const attention = useNeedsYou().length;
  const activeOverview =
    pathname === "/society"
      ? SOCIETY_SCOPE
      : (/^\/p\/([^/]+)$/.exec(pathname)?.[1] ??
        /^\/knowledge\/([^/]+)\//.exec(pathname)?.[1] ??
        null);

  useEffect(() => {
    const onPointer = (): void => {
      pointerFocus.current = true;
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Tab") {
        pointerFocus.current = false;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target?.closest("input, textarea, select, [contenteditable]") != null;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === " ") {
        // A control reached by Tab takes Space as its own press; one merely clicked does not.
        const control = target?.closest("button, a, summary, [role='button']") != null;
        if (control && !pointerFocus.current) {
          return;
        }
        event.preventDefault();
        setAskAt(pathname);
        return;
      }
      if (event.key !== "Escape") {
        return;
      }
      // What floats over the board closes first.
      if (askOpen) {
        setAskAt(null);
      } else if (logsOpen) {
        setLogsOpen(false);
      } else if (boardOpen) {
        void navigate({ to: "/" });
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [boardOpen, logsOpen, askOpen, pathname, navigate]);

  const rejected = [society, members, projects, scheduler].some(
    (query) => query.error instanceof ApiError && query.error.status === 401,
  );
  useEffect(() => {
    if (rejected) {
      signOut();
    }
  }, [rejected, signOut]);

  const model = useMemo(
    () =>
      members.data === undefined || projects.data === undefined || scheduler.data === undefined
        ? null
        : skyModel({
            members: members.data,
            projects: projects.data,
            scheduler: scheduler.data,
            tasks,
          }),
    [members.data, projects.data, scheduler.data, tasks],
  );

  if (model === null) {
    const unreachable = [members, projects, scheduler].some((query) => query.error !== null);
    return (
      <main className="grid h-full place-items-center">
        <p className="text-meta" aria-live="polite">
          {unreachable ? "The board server is not answering. Retrying…" : "Reading the board…"}
        </p>
      </main>
    );
  }

  // Governance belongs to the society as a whole.
  const focus =
    (activeGovernance === null ? null : SOCIETY_SCOPE) ??
    activeOverview ??
    activeTasks ??
    (activeChannel === null
      ? activeCitizen === null
        ? null
        : (activePlace ??
          model.stars.find((candidate) => candidate.name === activeCitizen)?.anchor ??
          null)
      : activeChannel.includes("/")
        ? (activeChannel.split("/")[0] ?? null)
        : SOCIETY_SCOPE);
  // The ask box sits in the middle of the sky, or of the window when the islands leave too little.
  const skyWidth = width - insets.left - insets.right;
  const roomy = skyWidth >= 460;
  const askWidth = Math.min(560, (roomy ? skyWidth : width) - 32);
  const askBox = {
    left: (roomy ? insets.left : 0) + ((roomy ? skyWidth : width) - askWidth) / 2,
    width: askWidth,
  };
  const unread = asksOf(threads.data ?? []).filter((ask) => hasUnseenReply(ask, seen));
  const placeName = (scope: string): string =>
    scope === SOCIETY_SCOPE
      ? "the society"
      : (projects.data?.find((project) => project.slug === scope)?.name ?? scope);
  const star = model.stars.find((candidate) => candidate.id === hovered);
  const mark = model.tasks.find((candidate) => `task:${candidate.id}` === hovered);
  const member = members.data?.find((candidate) => candidate.name === star?.name);
  // A queued star waits at the core; its card says where the turn will run.
  const place = star === undefined ? "the society" : placeName(star.queuedFor ?? star.anchor);
  const openStar = (id: string): void => {
    const chosen = model.stars.find((candidate) => candidate.id === id);
    if (chosen !== undefined) {
      void navigate({
        to: "/citizen/$name",
        params: { name: chosen.name },
        search: chosen.state === "working" ? { scope: chosen.anchor } : {},
      });
    }
  };
  const openTask = (id: string): void => {
    void navigate({ to: "/task/$taskId", params: { taskId: id } });
  };
  const openProject = (anchor: string): void => {
    void navigate(
      anchor === SOCIETY_SCOPE ? { to: "/society" } : { to: "/p/$slug", params: { slug: anchor } },
    );
  };

  return (
    <LiveContext value={live}>
      <EntityContext value={entities}>
        <main className="relative h-full overflow-hidden">
          <Sky
            model={model}
            paused={scheduler.data?.paused ?? false}
            hovered={hovered}
            onHover={setHovered}
            insets={insets}
            focus={focus}
            onSelectAnchor={openProject}
            onSelectStar={openStar}
            onSelectTask={openTask}
            live={live}
            card={
              mark !== undefined ? (
                <TaskCard mark={mark} project={placeName(mark.project)} members={members.data} />
              ) : star === undefined || member === undefined ? null : (
                <CitizenCard member={member} star={star} place={place} now={now} />
              )
            }
          />
          <Hud
            society={society.data?.name}
            citizens={new Set(model.stars.map((candidate) => candidate.name)).size}
            citizensOpen={pathname === "/citizens"}
            onToggleCitizens={() =>
              void navigate(pathname === "/citizens" ? { to: "/" } : { to: "/citizens" })
            }
            attention={attention}
            onOpenAttention={() => void navigate({ to: "/needs-you" })}
            paused={scheduler.data?.paused ?? false}
            onTogglePause={() => pause.mutate(!(scheduler.data?.paused ?? false))}
            pauseBusy={pause.isPending}
            boardOpen={boardOpen}
            onToggleBoard={() =>
              void navigate(boardOpen ? { to: "/" } : { to: "/c/$", params: { _splat: "general" } })
            }
            logsOpen={logsOpen}
            onToggleLogs={() => setLogsOpen(!logsOpen)}
            onSignOut={signOut}
          />
          {boardOpen ? (
            <Navigator
              activeChannel={activeChannel}
              activeTasks={activeTasks}
              activeCitizen={activeCitizen}
              activeScope={activeScope}
              activeGovernance={activeGovernance}
              activeOverview={activeOverview}
            />
          ) : null}
          {boardOpen ? (
            <Island
              label="Board content"
              className="top-[72px] right-4 bottom-4"
              style={{ width: contentWidth }}
            >
              <Outlet />
            </Island>
          ) : null}
          {logsOpen ? <LogsIsland onClose={() => setLogsOpen(false)} /> : null}
          {askOpen ? (
            <AskBox left={askBox.left} width={askBox.width} onClose={closeAsk} />
          ) : (
            <div
              className="pointer-events-none absolute bottom-5 flex justify-center px-16"
              style={{ left: insets.left, right: insets.right }}
            >
              <AskHint unread={unread} onOpen={() => setAskAt(pathname)} />
            </div>
          )}
          {model.stars.length === 0 && !boardOpen ? (
            <p className="pointer-events-none absolute inset-x-0 top-1/2 mt-24 text-center text-meta">
              No citizens yet. Ask the concierge for one, or add one with{" "}
              <code className="font-mono text-fg-secondary">stellaris agent add</code>.
            </p>
          ) : null}
          {/* The sky for keyboards and screen readers: focusing a citizen or a task shows its card, choosing it opens it. */}
          <ul className="sr-only" aria-label="Tasks in play">
            {model.tasks.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onFocus={() => setHovered(`task:${candidate.id}`)}
                  onBlur={() => setHovered(null)}
                  onClick={() => openTask(candidate.id)}
                >
                  Task {candidate.title}, {candidate.phase} at {placeName(candidate.project)}
                </button>
              </li>
            ))}
          </ul>
          <ul className="sr-only" aria-label="Citizens">
            {model.stars.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onFocus={() => setHovered(candidate.id)}
                  onBlur={() => setHovered(null)}
                  onClick={() => openStar(candidate.id)}
                >
                  {candidate.name}, {candidate.state}
                  {candidate.state === "working" ? ` at ${placeName(candidate.anchor)}` : ""}
                </button>
              </li>
            ))}
          </ul>
        </main>
      </EntityContext>
    </LiveContext>
  );
}
