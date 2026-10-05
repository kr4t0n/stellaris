import { describe, expect, it } from "vitest";
import { readSignInFragment } from "./signin.js";

describe("readSignInFragment", () => {
  it("reads the token the board's GitHub sign-in hands over", () => {
    expect(readSignInFragment("#session=stl_abc%2Bdef")).toEqual({
      token: "stl_abc+def",
      error: null,
    });
  });

  it("explains a refused sign-in, and anything unknown as a failure", () => {
    expect(readSignInFragment("#signin-error=not-allowed")?.error).toBe(
      "That GitHub account is not allowed on this board.",
    );
    expect(readSignInFragment("#signin-error=other")).toEqual({
      token: null,
      error: "GitHub sign-in failed.",
    });
  });

  it("leaves any other fragment alone", () => {
    expect(readSignInFragment("")).toBeNull();
    expect(readSignInFragment("#section-2")).toBeNull();
  });
});
