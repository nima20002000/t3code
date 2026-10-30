import { forkReleaseForSpec, isForkVersion, type ForkReleaseEntry } from "@t3tools/board-core";
import { cliReleaseIndexPageUrl } from "@t3tools/shared/cliRelease";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/http";

const FRESH_MS = 4 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 30 * 60_000;
const MAX_PAGES = 10;

/** GitHub refused the anonymous request (rate limit); lookups pause until `retryAt`. */
export class ForkReleasesRateLimited extends Schema.TaggedError<ForkReleasesRateLimited>()(
  "ForkReleasesRateLimited",
  { retryAt: Schema.Number },
) {}

/** When GitHub's limit resets, from its headers, or a fixed pause when it does not say. */
function retryAtFrom(response: HttpClientResponse.HttpClientResponse, now: number): number {
  const reset = Number(response.headers["x-ratelimit-reset"]);
  const retryAfter = Number(response.headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
  if (Number.isFinite(reset) && reset * 1000 > now) return reset * 1000;
  return now + RATE_LIMIT_BACKOFF_MS;
}

/**
 * One shared copy of the fork's release list per client: every lookup (each version or track an
 * update check asks about) reads it, it is fetched at most every few minutes, and a rate-limited
 * GitHub pauses fetching until its limit resets, so the anonymous per-IP quota is never burned.
 */
export function makeForkReleaseSource() {
  const permit = Semaphore.makeUnsafe(1);
  let cached: { readonly at: number; readonly releases: ReadonlyArray<ForkReleaseEntry> } | null =
    null;
  let pausedUntil = 0;

  const fetchAll = Effect.fn("board.forkReleases.fetch")(function* (now: number) {
    const releases: ForkReleaseEntry[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = yield* HttpClient.get(cliReleaseIndexPageUrl(page));
      if (response.status === 403 || response.status === 429) {
        return yield* new ForkReleasesRateLimited({ retryAt: retryAtFrom(response, now) });
      }
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      const entries = Array.isArray(body)
        ? body.filter(
            (entry): entry is ForkReleaseEntry =>
              typeof entry === "object" && entry !== null && typeof entry.tag_name === "string",
          )
        : [];
      releases.push(...entries);
      if (!Array.isArray(body) || body.length < 100) break;
    }
    return releases;
  });

  const releases = permit.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (cached !== null && now - cached.at < FRESH_MS) return cached.releases;
      if (now < pausedUntil) {
        if (cached !== null) return cached.releases;
        return yield* new ForkReleasesRateLimited({ retryAt: pausedUntil });
      }
      return yield* fetchAll(now).pipe(
        Effect.tap((fresh) =>
          Effect.sync(() => {
            cached = { at: now, releases: fresh };
          }),
        ),
        Effect.catchTags({
          ForkReleasesRateLimited: (limited) =>
            Effect.sync(() => {
              pausedUntil = limited.retryAt;
            }).pipe(
              Effect.andThen(
                cached === null ? Effect.fail(limited) : Effect.succeed(cached.releases),
              ),
            ),
        }),
      );
    }),
  );

  /**
   * t3's release lookups (is a version out yet, what is the newest on a track) answered from the
   * fork's GitHub releases instead of npm: fork versions are never on npm, and npm's newer
   * upstream `t3` must never be offered. Fork releases carry no npm manifest, so no migration.
   */
  const lookup = Effect.fn("board.lookupForkRelease")(function* (spec: string) {
    if (spec !== "latest" && !isForkVersion(spec)) return null;
    const version = forkReleaseForSpec(spec, yield* releases);
    return version === null ? null : { version, databaseMigration: undefined };
  });
  return { lookup };
}

export const lookupForkRelease = makeForkReleaseSource().lookup;
