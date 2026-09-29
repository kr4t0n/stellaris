import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { getToken } from "./api/client.js";
import { Layout } from "./components/Layout.js";
import { CitizenPage } from "./pages/Citizen.js";
import { InboxPage } from "./pages/Inbox.js";
import { LibraryPage } from "./pages/Library.js";
import { LivePage } from "./pages/Live.js";
import { LoginPage } from "./pages/Login.js";
import {
  ChannelPane,
  DashboardPane,
  KnowledgePane,
  ProjectOverview,
  ProjectPage,
  TaskPane,
  TasksPane,
} from "./pages/Project.js";
import { SocietyPage } from "./pages/Society.js";

function requireToken(): void {
  if (getToken() === null) {
    throw redirect({ to: "/login" });
  }
}

/** The world alone: the drawer is closed. */
function WorldOnly() {
  return null;
}

const rootRoute = createRootRoute({ component: Layout });

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

export const worldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireToken,
  component: WorldOnly,
});

export const deskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/desk",
  beforeLoad: requireToken,
  component: InboxPage,
});

export const societyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/society",
  beforeLoad: requireToken,
  component: SocietyPage,
});

export const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  beforeLoad: requireToken,
  component: LibraryPage,
});

export const liveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/live",
  beforeLoad: requireToken,
  component: LivePage,
});

export const citizenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/citizens/$name",
  beforeLoad: requireToken,
  component: CitizenPage,
});

export const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$slug",
  beforeLoad: requireToken,
  component: ProjectPage,
});

export const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: ProjectOverview,
});

export const channelRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/channels/$channel",
  component: ChannelPane,
});

export const tasksRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/tasks",
  component: TasksPane,
});

export const taskRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/tasks/$taskId",
  component: TaskPane,
});

export const dashboardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/dashboard",
  component: DashboardPane,
});

export const knowledgeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/knowledge",
  component: KnowledgePane,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  worldRoute,
  deskRoute,
  societyRoute,
  libraryRoute,
  liveRoute,
  citizenRoute,
  projectRoute.addChildren([
    projectIndexRoute,
    channelRoute,
    tasksRoute,
    taskRoute,
    dashboardRoute,
    knowledgeRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
