import { forkReleaseForSpec, type ForkReleaseEntry } from "@t3tools/board-core";
import { cliReleaseIndexPageUrl } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

/**
 * t3's release lookups (is a version out yet, what is the newest on a track) answered from the
 * fork's GitHub releases instead of npm: fork versions are never on npm, and npm's newer upstream
 * `t3` must never be offered. Fork releases carry no npm manifest, so no migration number.
 */
export const lookupForkRelease = Effect.fn("board.lookupForkRelease")(function* (spec: string) {
  const response = yield* HttpClient.get(cliReleaseIndexPageUrl(1));
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap((ok) => ok.json),
  );
  const releases: ReadonlyArray<ForkReleaseEntry> = Array.isArray(body)
    ? body.filter(
        (entry): entry is ForkReleaseEntry =>
          typeof entry === "object" && entry !== null && typeof entry.tag_name === "string",
      )
    : [];
  const version = forkReleaseForSpec(spec, releases);
  return version === null ? null : { version, databaseMigration: undefined };
});
