import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { api, getToken, setToken } from "../api/client.js";
import { useBoardEvents } from "../hooks/useBoardEvents.js";
import { LivePanel } from "./LivePanel.js";
import { Pill } from "./ui.js";

const linkClass =
  "block rounded px-3 py-1.5 text-sm text-board-muted hover:bg-board-panel hover:text-board-text [&.active]:bg-board-panel [&.active]:text-board-text";

function Shell() {
  useBoardEvents();
  const society = useQuery({ queryKey: ["society"], queryFn: api.society });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: api.scheduler,
    refetchInterval: 5_000,
  });
  const [live, setLive] = useState(true);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const projectSlug = /^\/projects\/([^/]+)/.exec(pathname)?.[1];

  return (
    <div className="flex min-h-screen bg-board-bg text-board-text">
      <nav className="flex w-56 shrink-0 flex-col gap-4 border-r border-board-border p-3">
        <div>
          <div className="px-3 text-lg font-semibold">{society.data?.name ?? "Stellaris"}</div>
          <div className="px-3 text-xs text-board-muted">
            {me.data === undefined ? "" : `${me.data.name} · ${me.data.role}`}
          </div>
        </div>
        <div className="space-y-1">
          <Link to="/" className={linkClass} activeOptions={{ exact: true }}>
            Inbox
          </Link>
          <Link to="/society" className={linkClass}>
            Society
          </Link>
        </div>
        <div>
          <div className="px-3 text-[11px] font-semibold uppercase tracking-wide text-board-muted">
            Projects
          </div>
          <div className="mt-1 space-y-1">
            {(projects.data ?? []).map((project) => (
              <Link
                key={project.slug}
                to="/projects/$slug"
                params={{ slug: project.slug }}
                className={linkClass}
              >
                {project.name}
              </Link>
            ))}
          </div>
        </div>
        <div className="mt-auto space-y-2 px-3 text-xs text-board-muted">
          {scheduler.data?.paused ? (
            <Pill className="border-amber-800 text-amber-300">society paused</Pill>
          ) : (
            <Pill className="border-emerald-800 text-emerald-300">
              {scheduler.data?.running.length ?? 0} running
            </Pill>
          )}
          <button
            type="button"
            onClick={() => setLive((value) => !value)}
            className="block hover:text-board-text"
          >
            {live ? "Hide live panel" : "Show live panel"}
          </button>
          <button
            type="button"
            onClick={() => {
              setToken(null);
              window.location.href = "/login";
            }}
            className="block hover:text-board-text"
          >
            Sign out
          </button>
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
      {live ? (
        <div className="w-96 shrink-0 border-l border-board-border p-3">
          <LivePanel project={projectSlug} />
        </div>
      ) : null}
    </div>
  );
}

/** The root layout: the login page stands alone; everything else gets the navigation and live panel. */
export function Layout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (pathname === "/login" || getToken() === null) {
    return (
      <div className="min-h-screen bg-board-bg text-board-text">
        <Outlet />
      </div>
    );
  }
  return <Shell />;
}
