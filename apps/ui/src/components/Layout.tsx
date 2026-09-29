import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { getToken } from "../api/client.js";
import { useBoardEvents } from "../hooks/useBoardEvents.js";
import { useWorldSnapshot } from "../hooks/useWorldSnapshot.js";
import { Playground } from "./Playground.js";

/** The world underneath, and the routed page as a drawer over it; the root route shows the world alone. */
function Shell() {
  useBoardEvents();
  const snapshot = useWorldSnapshot();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const open = pathname !== "/";
  return (
    <>
      <Playground snapshot={snapshot} />
      {open ? (
        <aside
          data-testid="drawer"
          className="fixed top-12 right-0 bottom-0 z-20 flex w-[600px] max-w-full flex-col border-l border-board-border bg-board-panel/95 text-board-text shadow-2xl backdrop-blur"
        >
          <div className="flex items-center justify-end border-b border-board-border px-3 py-1">
            <Link
              to="/"
              className="rounded px-2 py-1 text-xs text-board-muted hover:bg-board-bg hover:text-board-text"
              aria-label="Close the drawer"
            >
              Close ✕
            </Link>
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto p-4">
            <Outlet />
          </main>
        </aside>
      ) : (
        <Outlet />
      )}
    </>
  );
}

/** The root layout: the login page stands alone; everything else is the playground. */
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
