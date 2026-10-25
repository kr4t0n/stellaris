import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { MetricsWindowSchema, UlidSchema, type MetricsWindow } from "@stellaris/shared";
import type { CitizenTab } from "./board/citizen.js";
import { Playground } from "./Playground.js";

/** A view's `message` search: the message a link named, which the view marks. */
function messageSearch(search: Record<string, unknown>): { message?: string } {
  const message = UlidSchema.safeParse(search["message"]);
  return message.success ? { message: message.data } : {};
}

/** A file view's `line` search: the line a link cited, which the view marks. */
function lineSearch(search: Record<string, unknown>): { line?: number } {
  const line = Number(search["line"]);
  return Number.isInteger(line) && line > 0 ? { line } : {};
}

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
    // `message` is one text named by its id, marked in the stream and scrolled to.
    validateSearch: messageSearch,
    component: lazyRouteComponent(() => import("./board/ChannelView.js"), "ChannelView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/thread/$threadId",
    validateSearch: messageSearch,
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
    path: "/skills/$name",
    component: lazyRouteComponent(() => import("./board/SkillView.js"), "SkillView"),
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
    // A file or folder on the task's branch, by its path there; `line` is the line a link cited.
    path: "/task/$taskId/files/$",
    validateSearch: lineSearch,
    component: lazyRouteComponent(() => import("./board/FileView.js"), "TaskFileView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    // A file or folder on the project's default branch, as a task's files are addressed.
    path: "/p/$slug/files/$",
    validateSearch: lineSearch,
    component: lazyRouteComponent(() => import("./board/FileView.js"), "ProjectFileView"),
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
    // `window` picks how far back the citizens' tokens count; a day when none is named.
    validateSearch: (search: Record<string, unknown>): { window?: MetricsWindow } => {
      const window = MetricsWindowSchema.safeParse(search["window"]);
      return window.success ? { window: window.data } : {};
    },
    component: lazyRouteComponent(() => import("./board/CitizensView.js"), "CitizensView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/needs-you",
    component: lazyRouteComponent(() => import("./board/NeedsYouView.js"), "NeedsYouView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/runners",
    // `code` is the enrollment a runner printed a link to, shown first and marked.
    validateSearch: (search: Record<string, unknown>): { code?: string } =>
      typeof search["code"] === "string" ? { code: search["code"] } : {},
    component: lazyRouteComponent(() => import("./board/RunnersView.js"), "RunnersView"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/crons",
    // `agent` shows one citizen's crons, as its view links them; `cron` opens one, as text that
    // names it links it.
    validateSearch: (search: Record<string, unknown>): { agent?: string; cron?: string } => ({
      ...(typeof search["agent"] === "string" ? { agent: search["agent"] } : {}),
      ...(typeof search["cron"] === "string" ? { cron: search["cron"] } : {}),
    }),
    component: lazyRouteComponent(() => import("./board/CronsView.js"), "CronsView"),
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
    // its turns, its memory, or its home's history over what it is doing now; `turn` opens one of
    // its finished turns.
    validateSearch: (
      search: Record<string, unknown>,
    ): { scope?: string; tab?: CitizenTab; turn?: string } => ({
      ...(typeof search["scope"] === "string" ? { scope: search["scope"] } : {}),
      ...(search["tab"] === "turns" || search["tab"] === "memory" || search["tab"] === "history"
        ? { tab: search["tab"] }
        : {}),
      ...(typeof search["turn"] === "string" ? { turn: search["turn"] } : {}),
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
