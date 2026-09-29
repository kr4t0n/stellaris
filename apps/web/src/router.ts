import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
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
    path: "/citizen/$name",
    component: lazyRouteComponent(() => import("./board/CitizenView.js"), "CitizenView"),
  }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
