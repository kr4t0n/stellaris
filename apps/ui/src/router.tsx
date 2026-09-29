import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { getToken } from "./api/client.js";
import { Layout } from "./components/Layout.js";
import { InboxPage } from "./pages/Inbox.js";
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

const rootRoute = createRootRoute({ component: Layout });

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

export const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireToken,
  component: InboxPage,
});

export const societyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/society",
  beforeLoad: requireToken,
  component: SocietyPage,
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
  inboxRoute,
  societyRoute,
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
