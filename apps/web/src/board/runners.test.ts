import { NAME_PATTERN } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { identityGap, offVersion, sameCode, suggestRunnerName } from "./runners.js";

describe("suggestRunnerName", () => {
  it("takes the hostname's first label as a name", () => {
    expect(suggestRunnerName("Studio-Mac.local", [])).toBe("studio-mac");
    expect(suggestRunnerName("gpu_box 01", [])).toBe("gpu-box-01");
  });

  it("numbers a name the society has already", () => {
    expect(suggestRunnerName("pod", ["pod"])).toBe("pod-2");
    expect(suggestRunnerName("pod", ["pod", "pod-2"])).toBe("pod-3");
  });

  it("always gives a valid name", () => {
    for (const hostname of ["", "---", "_.example.com", "x".repeat(80), "Ünïcode-host"]) {
      expect(suggestRunnerName(hostname, [])).toMatch(NAME_PATTERN);
    }
    expect(suggestRunnerName("", [])).toBe("runner");
    expect(suggestRunnerName("x".repeat(80), ["x".repeat(32)])).toBe(`${"x".repeat(30)}-2`);
  });
});

describe("offVersion", () => {
  it("marks only a known version that differs from the server's", () => {
    expect(offVersion({ version: "0.3.10" }, "0.3.11")).toBe(true);
    expect(offVersion({ version: "0.3.12" }, "0.3.11")).toBe(true);
    expect(offVersion({ version: "0.3.11" }, "0.3.11")).toBe(false);
    expect(offVersion({}, "0.3.11")).toBe(false);
    expect(offVersion({ version: "0.3.10" })).toBe(false);
  });
});

describe("identityGap", () => {
  it("marks only a runner that reported a gap in its account's git identity", () => {
    expect(identityGap({})).toBeNull();
    expect(identityGap({ gitIdentityMissing: [] })).toBeNull();
    expect(identityGap({ gitIdentityMissing: ["name"] })).toEqual({
      label: "no git user.name",
      detail:
        "Its account has no git user.name, so git refuses the commits citizens make themselves on it. Set it with git config --global there; the mark goes once the runner connects with it set.",
    });
    expect(identityGap({ gitIdentityMissing: ["email"] })).toEqual({
      label: "no git user.email",
      detail:
        "Its account has no git user.email, so the commits citizens make themselves on it carry an empty address or one git made up. Set it with git config --global there; the mark goes once the runner connects with it set.",
    });
    expect(identityGap({ gitIdentityMissing: ["name", "email"] })).toMatchObject({
      label: "no git identity",
      detail: expect.stringMatching(
        /^Its account has no git user\.name or user\.email, so git refuses/,
      ),
    });
  });
});

describe("sameCode", () => {
  it("ignores case and separators", () => {
    expect(sameCode("bcdf-ghjk", "BCDFGHJK")).toBe(true);
    expect(sameCode("BCDF-GHJK", "BCDF-GHJL")).toBe(false);
  });
});
