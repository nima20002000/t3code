import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { BoardHttpApi } from "@t3tools/board-core/http";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { layer as primaryHttpLayer } from "../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { BoardEvent } from "@t3tools/board-core/http";

const runtime = ManagedRuntime.make(primaryHttpLayer);

type Client = HttpApiClient.ForApi<typeof BoardHttpApi>;

export function runBoardApi<A, E>(
  operation: (client: Client["board"]) => Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  return runtime.runPromise(
    Effect.flatMap(
      HttpApiClient.make(BoardHttpApi, { baseUrl: resolvePrimaryEnvironmentHttpUrl("/") }),
      (client) => operation(client.board),
    ),
    signal ? { signal } : undefined,
  );
}

const boardPendingAtom = Atom.make(0);

export function useBoardPending() {
  return useAtomValue(boardPendingAtom) > 0;
}

export async function runBoardMutation<A, E>(
  operation: (client: Client["board"]) => Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  appAtomRegistry.set(boardPendingAtom, appAtomRegistry.get(boardPendingAtom) + 1);
  try {
    return await runBoardApi(operation, signal);
  } finally {
    appAtomRegistry.set(boardPendingAtom, appAtomRegistry.get(boardPendingAtom) - 1);
  }
}

export function streamBoardEvents(
  afterSequence: number,
  onEvent: (event: BoardEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return runBoardApi(
    (client) =>
      Effect.flatMap(client.events({ headers: {}, query: { afterSequence } }), (stream) =>
        Stream.runForEach(stream, (event) => Effect.sync(() => onEvent(event))),
      ),
    signal,
  );
}
