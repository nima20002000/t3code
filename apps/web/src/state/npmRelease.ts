import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { lookupForkRelease } from "~/board/forkReleaseLookup";
import { AsyncResult, Atom } from "effect/reactivity";

export interface NpmRelease {
  readonly version: string;
  /** Absent on releases published before npm manifests carried it. */
  readonly databaseMigration: number | undefined;
}

/** `spec` is an exact version or a dist-tag such as `nightly`. Null when npm has no such release.
 * Refreshes only while mounted; the published check below keeps its own versions alive. */
export const npmReleaseAtom = Atom.family((spec: string) =>
  Atom.make(
    // Board fork: releases come from the fork's GitHub releases, never from npm's upstream `t3`.
    lookupForkRelease(spec).pipe(
      Effect.map((release): NpmRelease | null => release),
      // Tracing headers would make the browser send a CORS preflight, which npm rejects.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(Atom.withRefresh("5 minutes"), Atom.withLabel(`npm-release:${spec}`)),
);

export const npmReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make((get) =>
    get.result(npmReleaseAtom(version)).pipe(Effect.map((release) => release?.version === version)),
  ).pipe(Atom.keepAlive, Atom.withLabel(`npm-release-published:${version}`)),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("npm-release-published:none"),
);

export function useNpmReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? npmReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
