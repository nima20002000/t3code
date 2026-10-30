/** A release from the GitHub releases API, as much of it as the fork's update checks read. */
export interface ForkReleaseEntry {
  readonly tag_name: string;
  readonly draft?: boolean | undefined;
  readonly prerelease?: boolean | undefined;
}

const FORK_VERSION = /^(\d+)\.(\d+)\.(\d+)-board\.(\d+)$/;

/** Fork builds are `<upstream base>-board.<n>`; anything else is an upstream t3 version. */
export function isForkVersion(version: string): boolean {
  return FORK_VERSION.test(version);
}

function forkVersionParts(version: string): ReadonlyArray<number> | undefined {
  return FORK_VERSION.exec(version)?.slice(1).map(Number);
}

/** Orders fork versions by base, then build number. Both must be fork versions. */
export function compareForkVersions(a: string, b: string): number {
  const left = forkVersionParts(a) ?? [];
  const right = forkVersionParts(b) ?? [];
  for (let index = 0; index < 4; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Published fork releases only: drafts, pre-releases and upstream tags never count. */
export function publishedForkVersions(
  releases: ReadonlyArray<ForkReleaseEntry>,
): ReadonlyArray<string> {
  return releases
    .flatMap((release) => {
      if (release.draft === true || release.prerelease === true) return [];
      const version = /^v(.+)$/.exec(release.tag_name)?.[1];
      return version !== undefined && isForkVersion(version) ? [version] : [];
    })
    .toSorted(compareForkVersions);
}

export function newestForkVersion(releases: ReadonlyArray<ForkReleaseEntry>): string | undefined {
  return publishedForkVersions(releases).at(-1);
}

/** The release a fork build should move to: the newest fork release above it, never an upstream
 * one and never a downgrade. A build that is not a fork version is never moved. */
export function forkUpdateTarget(
  currentVersion: string,
  releases: ReadonlyArray<ForkReleaseEntry>,
): string | undefined {
  if (!isForkVersion(currentVersion)) return undefined;
  const newest = newestForkVersion(releases);
  return newest !== undefined && compareForkVersions(newest, currentVersion) > 0
    ? newest
    : undefined;
}

/** Answers t3's release lookups (an exact version, or the `latest`/`nightly` track) from the
 * fork's releases. The fork has no nightly track, and an upstream version is never published. */
export function forkReleaseForSpec(
  spec: string,
  releases: ReadonlyArray<ForkReleaseEntry>,
): string | null {
  if (spec === "latest") return newestForkVersion(releases) ?? null;
  // A pre-release still carries its archives, so a server can move to it when asked by version.
  const released = releases.some(
    (release) => release.draft !== true && release.tag_name === `v${spec}`,
  );
  return released && isForkVersion(spec) ? spec : null;
}
