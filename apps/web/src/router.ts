import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { MetricsWindowSchema, type MetricsWindow } from "@stellaris/shared";
import type { CitizenTab } from "./board/citizen.js";
import { Playground } from "./Playground.js";

/** The sky alone: nothing opens in the content island. */
function SkyOnly() {
  return null;
}

// The sky is the root layout; every other route is a view in the board's content island, so a
// channel or a thread is a link that opens with the board around it. The views load with the
// board, which keeps markdown rendering out of the sky's first load.
const rootRoute = createRootRoute({ component: Playground });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: SkyOnly }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/c/$",
    component: lazyRouteComponent(() => import("./board/ChannelView.js"), "ChannelView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/thread/$threadId",
    component: lazyRouteComponent(() => import("./board/ThreadView.js"), "ThreadView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/society",
    component: lazyRouteComponent(() => import("./board/SocietyView.js"), "SocietyView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/p/$slug",
    component: lazyRouteComponent(() => import("./board/ProjectView.js"), "ProjectView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/knowledge/$scope/$topic",
    component: lazyRouteComponent(() => import("./board/KnowledgeView.js"), "KnowledgeView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/p/$slug/tasks",
    component: lazyRouteComponent(() => import("./board/TasksView.js"), "TasksView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/task/$taskId",
    component: lazyRouteComponent(() => import("./board/TaskView.js"), "TaskView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/metrics",
    // `window` picks how far back the metrics look; a week when none is named.
    validateSearch: (search: Record<string, unknown>): { window?: MetricsWindow } => {
      const window = MetricsWindowSchema.safeParse(search["window"]);
      return window.success ? { window: window.data } : {};
    },
    component: lazyRouteComponent(() => import("./board/MetricsView.js"), "MetricsView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/citizens",
    component: lazyRouteComponent(() => import("./board/CitizensView.js"), "CitizensView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/needs-you",
    component: lazyRouteComponent(() => import("./board/NeedsYouView.js"), "NeedsYouView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/proposals",
    component: lazyRouteComponent(() => import("./board/ProposalsView.js"), "ProposalsView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/proposal/$proposalId",
    component: lazyRouteComponent(() => import("./board/ProposalView.js"), "ProposalView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/citizen/$name",
    // `scope` picks which of a citizen's turns to show, when it is in more than one; `tab` picks
    // its history or its memory over what it is doing now.
    validateSearch: (search: Record<string, unknown>): { scope?: string; tab?: CitizenTab } => ({
      ...(typeof search["scope"] === "string" ? { scope: search["scope"] } : {}),
      ...(search["tab"] === "turns" || search["tab"] === "memory" ? { tab: search["tab"] } : {}),
    }),
    component: lazyRouteComponent(() => import("./board/CitizenView.js"), "CitizenView"),
  }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
