import {
  cliReleaseChannelOf,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error The release script is plain JavaScript without type declarations.
import { RELEASE_REPOSITORY, nextBoardVersion } from "../../../../scripts/board-release.mjs";

describe("fork releases", () => {
  it("t3 update and remote installs read the fork's GitHub releases by default", () => {
    expect(RELEASE_REPOSITORY).toBe("nima20002000/t3code");
    expect(cliReleaseIndexPageUrl(1)).toBe(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=1`,
    );
    expect(cliReleaseDownloadBaseUrl("0.1.5-board.4")).toBe(
      `https://github.com/${RELEASE_REPOSITORY}/releases/download/v0.1.5-board.4`,
    );
  });

  it("an update finds the newest fork release on the stable track", () => {
    expect(cliReleaseChannelOf("0.1.5-board.4")).toBe("stable");
    expect(
      newestCliReleaseVersion(
        [
          { tag_name: "v0.1.6-nightly.20261030.3917" },
          { tag_name: "v0.1.5-board.5", draft: true },
          { tag_name: "v0.1.5-board.4" },
          { tag_name: "v0.1.5-board.3" },
        ],
        "stable",
      ),
    ).toBe("0.1.5-board.4");
  });

  it("fork versions rise with each build and across upstream bases", () => {
    const ordered = ["0.1.5-board.2", "0.1.5-board.10", "0.1.6-board.1"];
    expect(ordered.toSorted(compareSemverVersions)).toEqual(ordered);
  });

  it("the next build numbers itself after the last fork release of its upstream base", () => {
    expect(nextBoardVersion({ tags: ["v0.1.4", "v0.1.5", "v0.1.5-nightly.20261029.1"] })).toBe(
      "0.1.5-board.1",
    );
    expect(
      nextBoardVersion({ tags: ["v0.1.5", "v0.1.5-board.3", "v0.1.5-board.10", "v0.1.3-board.6"] }),
    ).toBe("0.1.5-board.11");
    expect(nextBoardVersion({ tags: ["v0.1.6", "v0.1.5-board.10"] })).toBe("0.1.6-board.1");
  });

  it("refuses a version that would not rise above the last fork release", () => {
    expect(() => nextBoardVersion({ tags: ["v0.1.5", "v0.1.6-board.1"] })).toThrow(
      /pass --version/,
    );
    expect(() =>
      nextBoardVersion({ tags: ["v0.1.5", "v0.1.5-board.3"], requested: "0.1.5-board.3" }),
    ).toThrow(/must be newer/);
    expect(() => nextBoardVersion({ tags: ["v0.1.5"], requested: "0.1.5" })).toThrow(
      /not a fork version/,
    );
    expect(
      nextBoardVersion({ tags: ["v0.1.5", "v0.1.5-board.3"], requested: "0.1.5-board.7" }),
    ).toBe("0.1.5-board.7");
  });
});
