import { describe, expect, it } from "vitest";
import {
  capOutput,
  channelConversation,
  channelRef,
  conversationPart,
  IsoDateTimeSchema,
  isSafeRelativePath,
  loadRunnerConfig,
  loadServerConfig,
  mayHoldStage,
  parseChannelRef,
  parseSessionKey,
  placeConversation,
  PlanStageSchema,
  RUNNER_PROTOCOL,
  RunnerHelloSchema,
  RunnerSchema,
  SEED_ROLES,
  sessionKey,
  TaskFrontmatterSchema,
  turnStatusJsonSchema,
  VerbInputs,
  wakeScope,
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

describe("conversations", () => {
  it("files a top-level post in the society scope in its project's conversation, any channel of it", () => {
    for (const channel of ["demo/general", "demo/dev"]) {
      expect(channelConversation("society", channel)).toBeUndefined();
      expect(placeConversation("society", channel)).toBe("demo");
    }
    // A member's turn is in the project's scope, where its channels keep their own conversations.
    expect(channelConversation("demo", "demo/dev")).toBe("dev");
    expect(placeConversation("demo", "demo/dev")).toBeUndefined();
    expect(placeConversation("demo", "demo/general")).toBeUndefined();
    // The society's own channels are no project's.
    expect(placeConversation("society", "general")).toBeUndefined();
    expect(channelConversation("society", "asks")).toBe("asks");
  });

  it("keys a project's conversation apart from a society channel of the same name, and a thread", () => {
    const place = sessionKey("concierge-1", "society", conversationPart({ place: "asks" }));
    const channel = sessionKey("concierge-1", "society", conversationPart({ channel: "asks" }));
    const thread = sessionKey(
      "concierge-1",
      "society",
      conversationPart({ thread: "01M3S000000000000000000AAA" }),
    );
    expect(place).toBe("concierge-1/society/~asks");
    expect(channel).toBe("concierge-1/society/#asks");
    expect(new Set([place, channel, thread, sessionKey("concierge-1", "society")]).size).toBe(4);
    expect(parseSessionKey(place)).toEqual({
      agent: "concierge-1",
      scope: "society",
      place: "asks",
    });
    expect(parseSessionKey(channel)).toEqual({
      agent: "concierge-1",
      scope: "society",
      channel: "asks",
    });
    expect(parseSessionKey(thread)).toEqual({
      agent: "concierge-1",
      scope: "society",
      thread: "01M3S000000000000000000AAA",
    });
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
      publicUrl: null,
      logLevel: "info",
      concurrency: null,
      turnTimeoutMs: 1_200_000,
      toolRounds: 60,
      residentIdleMs: 600_000,
      github: null,
      trustedProxies: 0,
    });
    expect(loadServerConfig({ STELLARIS_PORT: "5000" })).toMatchObject({
      port: 5000,
      publicUrl: null,
    });
    expect(loadServerConfig({ STELLARIS_PUBLIC_URL: "https://board.example/" }).publicUrl).toBe(
      "https://board.example",
    );
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
    expect(loadServerConfig({ STELLARIS_TRUSTED_PROXIES: "1" }).trustedProxies).toBe(1);
    expect(() => loadServerConfig({ STELLARIS_TRUSTED_PROXIES: "-1" })).toThrow(/0/);
    expect(() => loadServerConfig({ STELLARIS_TURN_TIMEOUT_MS: "forever" })).toThrow(/number/i);
  });

  it("reads GitHub sign-in whole or not at all", () => {
    const github = {
      STELLARIS_GITHUB_CLIENT_ID: "Iv1.abc",
      STELLARIS_GITHUB_CLIENT_SECRET: "secret",
      STELLARIS_GITHUB_USERS: "Kr4t0n, octocat",
    };
    expect(loadServerConfig(github).github).toEqual({
      clientId: "Iv1.abc",
      clientSecret: "secret",
      users: ["kr4t0n", "octocat"],
    });
    expect(() =>
      loadServerConfig({ ...github, STELLARIS_GITHUB_CLIENT_SECRET: undefined }),
    ).toThrow(/together/);
    expect(() => loadServerConfig({ ...github, STELLARIS_GITHUB_USERS: " " })).toThrow(/together/);
  });
});

describe("runner config", () => {
  it("reads the environment with defaults", () => {
    expect(loadRunnerConfig({ STELLARIS_RUNNER_TOKEN: "stl_runner" })).toEqual({
      serverUrl: "http://127.0.0.1:4700",
      token: "stl_runner",
      dataDir: "./runner-data",
      logLevel: "info",
      slots: 2,
      clis: ["claude", "codex"],
      capabilities: [],
    });
    expect(
      loadRunnerConfig({
        STELLARIS_RUNNER_TOKEN: "stl_runner",
        STELLARIS_CONCURRENCY: "unlimited",
        STELLARIS_CLIS: "codex",
        STELLARIS_CAPABILITIES: "gpu, docker",
      }),
    ).toMatchObject({ slots: null, clis: ["codex"], capabilities: ["gpu", "docker"] });
    // Without a token the runner enrolls, or uses what an enrollment saved.
    expect(loadRunnerConfig({ STELLARIS_RUNNER_TOKEN: " " }).token).toBeNull();
    expect(loadRunnerConfig({}).token).toBeNull();
  });
});

describe("runner protocol files", () => {
  it("accepts relative paths only", () => {
    expect(isSafeRelativePath("memory/core.md")).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a\\b"]) {
      expect(isSafeRelativePath(bad)).toBe(false);
    }
  });
});

describe("runner hello", () => {
  const older = {
    protocol: RUNNER_PROTOCOL,
    version: "0.3.21",
    os: "linux",
    clis: ["claude"],
    slots: 2,
  };

  it("leaves a git identity unknown when an older runner's hello does not say", () => {
    const hello = RunnerHelloSchema.parse(older);
    expect(hello).not.toHaveProperty("gitIdentityMissing");
    expect(hello.branchChanges).toBe(false);
    expect(
      RunnerSchema.parse({
        name: "pod",
        os: "linux",
        clis: [],
        capabilities: [],
        status: "connected",
      }),
    ).not.toHaveProperty("gitIdentityMissing");
  });

  it("carries what the runner's account lacks of a git identity, and nothing else", () => {
    expect(
      RunnerHelloSchema.parse({ ...older, gitIdentityMissing: [] }).gitIdentityMissing,
    ).toEqual([]);
    expect(
      RunnerHelloSchema.parse({ ...older, gitIdentityMissing: ["name", "email"] })
        .gitIdentityMissing,
    ).toEqual(["name", "email"]);
    expect(
      RunnerHelloSchema.safeParse({ ...older, gitIdentityMissing: ["signingkey"] }).success,
    ).toBe(false);
  });
});

describe("tool output", () => {
  it("keeps short output whole and long output's start and end", () => {
    expect(capOutput("ok")).toBe("ok");
    const long = `${"a".repeat(30)}${"b".repeat(30)}`;
    expect(capOutput(long, 20)).toBe(`${"a".repeat(10)}\n… 40 characters cut …\n${"b".repeat(10)}`);
  });
});

describe("wake scope", () => {
  it("wakes a citizen where it was asked: its project, else outside any project", () => {
    const member = { memberships: ["model-research", "lab"] };
    expect(wakeScope(member, "lab")).toBe("lab");
    // A society channel, or a project it is not in, gets a turn outside projects, not its first.
    expect(wakeScope(member, null)).toBe("society");
    expect(wakeScope(member, "pi-study")).toBe("society");
    expect(wakeScope({ memberships: [] }, null)).toBe("society");
  });
});
