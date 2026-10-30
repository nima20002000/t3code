import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { BoardHttpApi } from "@t3tools/board-core/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";

import type { BoardEvent } from "@t3tools/board-core/http";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  appAtomRegistry,
  environmentSummaries,
  primaryHttpLayer,
  readPreparedConnection,
  readPrimaryEnvironmentId,
  resolvePrimaryEnvironmentHttpUrl,
} from "./upstream";

const primaryRuntime = ManagedRuntime.make(primaryHttpLayer);
const remoteRuntime = ManagedRuntime.make(
  Layer.merge(
    layerRemoteHttpClient(globalThis.fetch),
    Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit" }),
  ),
);

type Client = HttpApiClient.ForApi<typeof BoardHttpApi>;

/** The primary environment when there is one (it keeps its own auth); otherwise the first connected one. */
function readBoardHubEnvironmentId() {
  return (
    readPrimaryEnvironmentId() ??
    appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom)[0] ??
    null
  );
}

function boardHub() {
  if (readPrimaryEnvironmentId() !== null) {
    return { remote: false, baseUrl: resolvePrimaryEnvironmentHttpUrl("/"), bearer: null };
  }
  const environmentId = readBoardHubEnvironmentId();
  const connection = environmentId ? readPreparedConnection(environmentId) : null;
  if (!connection) throw new Error("Connect an environment to use the board.");
  if (connection.httpAuthorization?._tag === "Dpop") {
    throw new Error("The board is not available over a relay connection yet.");
  }
  return {
    remote: true,
    baseUrl: connection.httpBaseUrl,
    bearer: connection.httpAuthorization?.token ?? null,
  };
}

export function runBoardApi<A, E>(
  operation: (client: Client["board"]) => Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const hub = boardHub();
  const { bearer } = hub;
  const program = Effect.flatMap(
    HttpApiClient.make(BoardHttpApi, { baseUrl: new URL("/", hub.baseUrl).toString() }),
    (client) => operation(client.board),
  );
  const authorized =
    bearer === null
      ? program
      : Effect.updateService(program, HttpClient.HttpClient, (client) =>
          HttpClient.mapRequest(client, (request) =>
            HttpClientRequest.bearerToken(request, bearer),
          ),
        );
  const options = signal ? { signal } : undefined;
  return hub.remote
    ? remoteRuntime.runPromise(authorized, options)
    : primaryRuntime.runPromise(authorized, options);
}

/** Pairs the hub with a machine this app is connected to, using the app's own login there to mint the code. */
export async function pairConnectedMachine(environmentId: EnvironmentId, name: string) {
  const connection = readPreparedConnection(environmentId);
  const authorization = connection?.httpAuthorization;
  if (!connection || authorization?._tag !== "Bearer") {
    throw new Error(`Pair ${name} from Machines: this app has no direct login there.`);
  }
  const mint = Effect.flatMap(
    HttpApiClient.make(EnvironmentHttpApi, {
      baseUrl: new URL("/", connection.httpBaseUrl).toString(),
    }),
    (client) =>
      client.auth.pairingCredential({
        headers: {},
        payload: {
          label: "Board hub",
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        },
      }),
  );
  const pairing = await remoteRuntime
    .runPromise(
      Effect.updateService(mint, HttpClient.HttpClient, (client) =>
        HttpClient.mapRequest(client, (request) =>
          HttpClientRequest.bearerToken(request, authorization.token),
        ),
      ),
    )
    .catch(() => {
      throw new Error(
        `Could not pair ${name} automatically; this app needs admin access there. Pair it from Machines.`,
      );
    });
  await runBoardMutation((client) =>
    client.pairPeer({
      headers: {},
      payload: { name, pairingUrlOrCode: pairing.credential, host: connection.httpBaseUrl },
    }),
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
