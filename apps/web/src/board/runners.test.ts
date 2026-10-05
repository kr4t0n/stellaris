import { NAME_PATTERN } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { sameCode, suggestRunnerName } from "./runners.js";

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

describe("sameCode", () => {
  it("ignores case and separators", () => {
    expect(sameCode("bcdf-ghjk", "BCDFGHJK")).toBe(true);
    expect(sameCode("BCDF-GHJK", "BCDF-GHJL")).toBe(false);
  });
});
