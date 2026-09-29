import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { ChannelView } from "./board/ChannelView.js";
import { ThreadView } from "./board/ThreadView.js";
import { Playground } from "./Playground.js";

/** The sky alone: nothing opens in the content island. */
function SkyOnly() {
  return null;
}

// The sky is the root layout; every other route is a view in the board's content island, so a
// channel or a thread is a link that opens with the board around it.
const rootRoute = createRootRoute({ component: Playground });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: SkyOnly }),
  createRoute({ getParentRoute: () => rootRoute, path: "/c/$", component: ChannelView }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/thread/$threadId",
    component: ThreadView,
  }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
