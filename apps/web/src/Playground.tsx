import { SOCIETY_SCOPE } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Navigator, type GovernanceView } from "./board/Navigator.js";
import { useNeedsYou } from "./board/useNeedsYou.js";
import { CitizenCard } from "./components/CitizenCard.js";
import { Hud } from "./components/Hud.js";
import { Island } from "./components/Island.js";
import { ApiError } from "./lib/api.js";
import { followBoardEvents, refreshFor } from "./lib/events.js";
import { LiveContext, LiveStore } from "./lib/live.js";
import {
  useMembers,
  useNow,
  useProjects,
  useRoles,
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
  const roles = useRoles();
  const scheduler = useScheduler();
  const threads = useThreads();
  const navigate = useNavigate();
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.setPaused(paused),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["scheduler"] }),
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useSearch({ strict: false });
  // The id of the hovered star: a citizen in turns in two projects has a star in each.
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
  const activeScope = activeCitizen === null ? null : (search.scope ?? null);
  const activeGovernance: GovernanceView | null =
    pathname === "/needs-you"
      ? "needs-you"
      : pathname === "/proposals" || pathname.startsWith("/proposal/")
        ? "proposals"
        : null;
  const attention = useNeedsYou().length;

  useEffect(() => {
    if (!boardOpen) {
      return undefined;
    }
    const close = (event: KeyboardEvent): void => {
      const typing =
        event.target instanceof HTMLElement && event.target.closest("input, textarea") !== null;
      if (event.key === "Escape" && !typing) {
        void navigate({ to: "/" });
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [boardOpen, navigate]);

  const rejected = [society, members, projects, roles, scheduler].some(
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
        : skyModel({ members: members.data, projects: projects.data, scheduler: scheduler.data }),
    [members.data, projects.data, scheduler.data],
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
    activeTasks ??
    (activeChannel === null
      ? activeCitizen === null
        ? null
        : (activeScope ??
          model.stars.find((candidate) => candidate.name === activeCitizen)?.anchor ??
          null)
      : activeChannel.includes("/")
        ? (activeChannel.split("/")[0] ?? null)
        : SOCIETY_SCOPE);
  const placeName = (scope: string): string =>
    scope === SOCIETY_SCOPE
      ? "the society"
      : (projects.data?.find((project) => project.slug === scope)?.name ?? scope);
  const star = model.stars.find((candidate) => candidate.id === hovered);
  const member = members.data?.find((candidate) => candidate.name === star?.name);
  // A queued star waits at the core; its card says where the turn will run.
  const place = star === undefined ? "the society" : placeName(star.queuedFor ?? star.anchor);
  const purpose = roles.data?.find((role) => role.name === member?.role)?.purpose;
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
  const working = model.stars.filter((candidate) => candidate.state === "working");
  const openProject = (anchor: string): void => {
    const first = projects.data?.find((project) => project.slug === anchor)?.channels[0];
    const channel = anchor === SOCIETY_SCOPE ? "general" : `${anchor}/${first ?? "general"}`;
    void navigate({ to: "/c/$", params: { _splat: channel } });
  };

  return (
    <LiveContext value={live}>
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
          card={
            star === undefined || member === undefined ? null : (
              <CitizenCard member={member} star={star} purpose={purpose} place={place} now={now} />
            )
          }
        />
        <Hud
          society={society.data?.name}
          citizens={new Set(model.stars.map((candidate) => candidate.name)).size}
          working={new Set(working.map((candidate) => candidate.name)).size}
          turns={working.length}
          queued={model.stars.filter((candidate) => candidate.state === "queued").length}
          attention={attention}
          onOpenAttention={() => void navigate({ to: "/needs-you" })}
          paused={scheduler.data?.paused ?? false}
          onTogglePause={() => pause.mutate(!(scheduler.data?.paused ?? false))}
          pauseBusy={pause.isPending}
          boardOpen={boardOpen}
          onToggleBoard={() =>
            void navigate(boardOpen ? { to: "/" } : { to: "/c/$", params: { _splat: "general" } })
          }
          onSignOut={signOut}
        />
        {boardOpen ? (
          <Navigator
            activeChannel={activeChannel}
            activeTasks={activeTasks}
            activeCitizen={activeCitizen}
            activeScope={activeScope}
            activeGovernance={activeGovernance}
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
        {model.stars.length === 0 && !boardOpen ? (
          <p className="pointer-events-none absolute inset-x-0 top-1/2 mt-24 text-center text-meta">
            No citizens yet. Ask the concierge for one, or add one with{" "}
            <code className="font-mono text-fg-secondary">stellaris agent add</code>.
          </p>
        ) : null}
        {/* The sky for keyboards and screen readers: focusing a citizen shows its card, choosing it opens it. */}
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
    </LiveContext>
  );
}
