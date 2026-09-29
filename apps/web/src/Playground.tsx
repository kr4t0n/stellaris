import { SOCIETY_SCOPE } from "@stellaris/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Navigator } from "./board/Navigator.js";
import { CitizenCard } from "./components/CitizenCard.js";
import { Hud } from "./components/Hud.js";
import { Island } from "./components/Island.js";
import { ApiError } from "./lib/api.js";
import { followBoardEvents, refreshFor } from "./lib/events.js";
import {
  useMembers,
  useNow,
  useProjects,
  useRoles,
  useScheduler,
  useSession,
  useSociety,
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

/** The channel a board route shows or belongs to, which is also the project the sky focuses. */
function channelOf(pathname: string, threadChannel: (id: string) => string | undefined) {
  if (pathname.startsWith("/c/")) {
    return decodeURIComponent(pathname.slice(3));
  }
  if (pathname.startsWith("/thread/")) {
    return threadChannel(decodeURIComponent(pathname.slice(8))) ?? null;
  }
  return null;
}

/**
 * The signed-in view and the root of every route: the sky of citizens, and when a board route is
 * open, the navigator island on the left and the content island on the right, the sky fitting
 * between them. The board's event stream keeps every read current.
 */
export function Playground() {
  const { token, signOut } = useSession();
  const client = useQueryClient();
  useEffect(
    () =>
      followBoardEvents(token, {
        onEvent: (event) => refreshFor(client, event),
        onResume: () => void client.invalidateQueries(),
      }),
    [token, client],
  );
  const society = useSociety();
  const members = useMembers();
  const projects = useProjects();
  const roles = useRoles();
  const scheduler = useScheduler();
  const threads = useThreads();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
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
  const activeChannel = channelOf(
    pathname,
    (id) => threads.data?.find((thread) => thread.id === id)?.channel,
  );
  const focus =
    activeChannel === null
      ? null
      : activeChannel.includes("/")
        ? (activeChannel.split("/")[0] ?? null)
        : SOCIETY_SCOPE;

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

  const star = model.stars.find((candidate) => candidate.name === hovered);
  const member = members.data?.find((candidate) => candidate.name === hovered);
  const place =
    star === undefined || star.anchor === SOCIETY_SCOPE
      ? "the society"
      : (projects.data?.find((project) => project.slug === star.anchor)?.name ?? star.anchor);
  const purpose = roles.data?.find((role) => role.name === member?.role)?.purpose;
  const openProject = (anchor: string): void => {
    const first = projects.data?.find((project) => project.slug === anchor)?.channels[0];
    const channel = anchor === SOCIETY_SCOPE ? "general" : `${anchor}/${first ?? "general"}`;
    void navigate({ to: "/c/$", params: { _splat: channel } });
  };

  return (
    <main className="relative h-full overflow-hidden">
      <Sky
        model={model}
        paused={scheduler.data?.paused ?? false}
        hovered={hovered}
        onHover={setHovered}
        insets={insets}
        focus={focus}
        onSelectAnchor={openProject}
        card={
          star === undefined || member === undefined ? null : (
            <CitizenCard member={member} star={star} purpose={purpose} place={place} now={now} />
          )
        }
      />
      <Hud
        society={society.data?.name}
        citizens={model.stars.length}
        working={model.stars.filter((candidate) => candidate.state === "working").length}
        queued={model.stars.filter((candidate) => candidate.state === "queued").length}
        paused={scheduler.data?.paused ?? false}
        boardOpen={boardOpen}
        onToggleBoard={() =>
          void navigate(boardOpen ? { to: "/" } : { to: "/c/$", params: { _splat: "general" } })
        }
        onSignOut={signOut}
      />
      {boardOpen ? <Navigator activeChannel={activeChannel} /> : null}
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
      {/* The sky for keyboards and screen readers: focusing a citizen shows the same card. */}
      <ul className="sr-only" aria-label="Citizens">
        {model.stars.map((candidate) => (
          <li key={candidate.name}>
            <button
              type="button"
              onFocus={() => setHovered(candidate.name)}
              onBlur={() => setHovered(null)}
            >
              {candidate.name}, {candidate.state}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
