import { describe, expect, it } from "vitest";
import {
  capOutput,
  channelRef,
  IsoDateTimeSchema,
  loadServerConfig,
  mayHoldStage,
  parseChannelRef,
  PlanStageSchema,
  SEED_ROLES,
  TaskFrontmatterSchema,
  turnStatusJsonSchema,
  VerbInputs,
} from "./index.js";

describe("turn status schema", () => {
  it("is a draft-7 object schema without a dialect reference, as the CLI validator requires", () => {
    const schema = turnStatusJsonSchema();
    expect(schema["$schema"]).toBeUndefined();
    expect(schema["type"]).toBe("object");
    expect(schema["properties"]).toHaveProperty("summary");
  });
});

describe("channel references", () => {
  it("parses society and project channels", () => {
    expect(parseChannelRef("general")).toEqual({ project: null, channel: "general" });
    expect(parseChannelRef("demo/dev")).toEqual({ project: "demo", channel: "dev" });
    expect(channelRef(null, "ops")).toBe("ops");
    expect(channelRef("demo", "general")).toBe("demo/general");
  });
});

describe("plans", () => {
  const ts = "2026-09-29T10:00:00.000Z";
  const task = TaskFrontmatterSchema.parse({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    project: "lab",
    title: "t",
    status: "open",
    createdBy: "user",
    createdAt: ts,
    updatedAt: ts,
    blockedBy: [],
    requiredCapabilities: [],
    stages: [
      { id: "s1", name: "draft", role: "writer", holders: ["ann"], completedBy: "ann" },
      { id: "s2", name: "referee review", role: "editor", gate: true },
    ],
    stage: "s2",
    stageSince: ts,
    stageSeq: 2,
  });

  it("admit the assignee's role, and keep a gated stage independent of earlier holders", () => {
    expect(mayHoldStage({ name: "bob", role: "editor" }, task)).toBe(true);
    expect(mayHoldStage({ name: "ann", role: "editor" }, task)).toBe(false);
    expect(mayHoldStage({ name: "cy", role: "writer" }, task)).toBe(false);
  });

  it("name a role or an agent for a stage, not both", () => {
    expect(PlanStageSchema.safeParse({ name: "x", role: "a", agent: "b" }).success).toBe(false);
    expect(PlanStageSchema.parse({ name: "x" })).toEqual({ name: "x", gate: false });
  });
});

describe("seed roles", () => {
  it("are the user, the steward, and the concierge, with no roles for the work itself", () => {
    expect(SEED_ROLES.map((role) => role.name).toSorted()).toEqual([
      "concierge",
      "steward",
      "user",
    ]);
  });

  it("give governance verbs to the user and steward only, and planning settings to the concierge too", () => {
    const withApprove = SEED_ROLES.filter((r) => r.verbs.includes("approve")).map((r) => r.name);
    expect(withApprove.toSorted()).toEqual(["steward", "user"]);
    const configurers = SEED_ROLES.filter((r) => r.verbs.includes("configure_project"));
    expect(configurers.map((r) => r.name).toSorted()).toEqual(["concierge", "steward", "user"]);
  });
});

describe("timestamps", () => {
  it("accepts Date objects produced by YAML parsers and normalizes them", () => {
    const iso = "2026-09-28T10:00:00.000Z";
    expect(IsoDateTimeSchema.parse(new Date(iso))).toBe(iso);
    expect(IsoDateTimeSchema.parse(iso)).toBe(iso);
  });
});

describe("verb inputs", () => {
  it("apply defaults", () => {
    expect(VerbInputs.read_inbox.parse({})).toEqual({ limit: 50, advance: true });
    expect(VerbInputs.create_task.parse({ project: "demo", title: "t" })).toMatchObject({
      body: "",
      required_capabilities: [],
    });
  });
});

describe("server config", () => {
  it("reads the environment with defaults", () => {
    expect(loadServerConfig({})).toEqual({
      dataDir: "./data",
      host: "127.0.0.1",
      port: 4700,
      logLevel: "info",
      concurrency: 2,
      turnTimeoutMs: 1_200_000,
      toolRounds: 60,
    });
    expect(loadServerConfig({ STELLARIS_PORT: "5000" }).port).toBe(5000);
  });

  it("reads a limit as a number or as unlimited", () => {
    const config = loadServerConfig({
      STELLARIS_CONCURRENCY: "unlimited",
      STELLARIS_TURN_TIMEOUT_MS: "Unlimited",
      STELLARIS_TOOL_ROUNDS: "unlimited",
    });
    expect([config.concurrency, config.turnTimeoutMs, config.toolRounds]).toEqual([
      null,
      null,
      null,
    ]);
    expect(loadServerConfig({ STELLARIS_CONCURRENCY: "4" }).concurrency).toBe(4);
    expect(() => loadServerConfig({ STELLARIS_TURN_TIMEOUT_MS: "forever" })).toThrow(/number/i);
  });
});

describe("tool output", () => {
  it("keeps short output whole and long output's start and end", () => {
    expect(capOutput("ok")).toBe("ok");
    const long = `${"a".repeat(30)}${"b".repeat(30)}`;
    expect(capOutput(long, 20)).toBe(`${"a".repeat(10)}\n… 40 characters cut …\n${"b".repeat(10)}`);
  });
});
