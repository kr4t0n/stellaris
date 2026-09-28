import { describe, expect, it } from "vitest";
import {
  canTransition,
  channelRef,
  IsoDateTimeSchema,
  loadServerConfig,
  parseChannelRef,
  SEED_ROLES,
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

describe("task transitions", () => {
  it("allows the documented edges and nothing else", () => {
    expect(canTransition("open", "claimed")).toBe(true);
    expect(canTransition("claimed", "in_review")).toBe(true);
    expect(canTransition("in_review", "done")).toBe(true);
    expect(canTransition("open", "done")).toBe(false);
    expect(canTransition("done", "open")).toBe(false);
  });
});

describe("seed roles", () => {
  it("give governance verbs to the owner and steward only", () => {
    const withApprove = SEED_ROLES.filter((r) => r.verbs.includes("approve")).map((r) => r.name);
    expect(withApprove.toSorted()).toEqual(["owner", "steward"]);
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
    });
    expect(loadServerConfig({ STELLARIS_PORT: "5000" }).port).toBe(5000);
  });
});
