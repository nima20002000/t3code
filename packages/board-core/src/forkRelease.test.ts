import { describe, expect, it } from "vite-plus/test";
import { forkReleaseForSpec, forkUpdateTarget } from "./forkRelease.ts";

// Newest first, as the GitHub releases API lists them.
const releases = [
  { tag_name: "v0.1.7" },
  { tag_name: "v0.1.6-nightly.20261030.3917", prerelease: true },
  { tag_name: "v0.1.5-board.12", draft: true },
  { tag_name: "v0.1.5-board.11", prerelease: true },
  { tag_name: "v0.1.5-board.10" },
  { tag_name: "v0.1.5-board.9" },
  { tag_name: "v0.1.4-board.30" },
];

describe("fork update target", () => {
  it("offers the newest published fork release above the running build", () => {
    expect(forkUpdateTarget("0.1.5-board.9", releases)).toBe("0.1.5-board.10");
    expect(forkUpdateTarget("0.1.4-board.30", releases)).toBe("0.1.5-board.10");
  });

  it("offers nothing when only upstream t3 has something newer", () => {
    expect(forkUpdateTarget("0.1.5-board.10", releases)).toBeUndefined();
    expect(
      forkUpdateTarget("0.1.5-board.10", [{ tag_name: "v9.0.0" }, { tag_name: "v0.1.5-board.10" }]),
    ).toBeUndefined();
  });

  it("never downgrades, and never moves a build that is not a fork build", () => {
    expect(forkUpdateTarget("0.1.6-board.1", releases)).toBeUndefined();
    expect(forkUpdateTarget("0.1.5", releases)).toBeUndefined();
    expect(forkUpdateTarget("0.1.5-board.9", [])).toBeUndefined();
  });
});

describe("release lookups answered from the fork", () => {
  it("the latest track is the newest published fork release, never upstream's", () => {
    expect(forkReleaseForSpec("latest", releases)).toBe("0.1.5-board.10");
    expect(forkReleaseForSpec("nightly", releases)).toBeNull();
  });

  it("an exact version counts only once the fork has published it", () => {
    expect(forkReleaseForSpec("0.1.5-board.9", releases)).toBe("0.1.5-board.9");
    expect(forkReleaseForSpec("0.1.5-board.11", releases)).toBe("0.1.5-board.11");
    expect(forkReleaseForSpec("0.1.5-board.12", releases)).toBeNull();
    expect(forkReleaseForSpec("0.1.7", releases)).toBeNull();
  });
});
