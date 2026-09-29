import {
  MemberSchema,
  NameSchema,
  ProjectSchema,
  RoleCharterSchema,
  SocietySchema,
} from "@stellaris/shared";
import { z } from "zod";

const TOKEN_KEY = "stellaris.token";

export function storedToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** A failed API call. Status 0 means the board server could not be reached at all. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ActorSchema = z.object({ name: NameSchema, role: NameSchema });
const RosterSchema = MemberSchema.extend({ profile: z.string() }).array();
/** Pairs are `agent/scope`, where the scope is a project slug or `society`. */
const SchedulerViewSchema = z.object({
  paused: z.boolean(),
  running: z.array(z.string()),
  pending: z.array(z.string()),
  resident: z.array(z.string()),
  signals: z.array(z.string()),
});
export type SchedulerView = z.infer<typeof SchedulerViewSchema>;

async function get<T>(path: string, token: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new ApiError(0, "The board server is not reachable.");
  }
  if (!response.ok) {
    throw new ApiError(response.status, `${path} answered ${response.status}`);
  }
  return schema.parse(await response.json());
}

/** The read side of the board's HTTP API, validated against the shared schemas. */
export function createApi(token: string) {
  return {
    me: () => get("/api/me", token, ActorSchema),
    society: () => get("/api/society", token, SocietySchema),
    members: () => get("/api/members", token, RosterSchema),
    projects: () => get("/api/projects", token, ProjectSchema.array()),
    roles: () => get("/api/roles", token, RoleCharterSchema.array()),
    scheduler: () => get("/api/scheduler", token, SchedulerViewSchema),
  };
}
export type Api = ReturnType<typeof createApi>;
