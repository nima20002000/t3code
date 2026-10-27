import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthWebSocketTicketResult,
  CommandId,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  type BoardDriverSettled,
  type BoardDriverThread,
  NodeDriverError,
  type NodeDriver,
} from "@t3tools/board-core/NodeDriver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { PeerHttpError, readDescriptor, request } from "./PeerPairing.ts";
import type { Peer, PeerStore } from "./PeerStore.ts";

const makeClient = RpcClient.make(WsRpcGroup);
const decodeTicket = Schema.decodeEffect(Schema.toCodecJson(AuthWebSocketTicketResult));
const isPeerHttpError = Schema.is(PeerHttpError);
type Client = Effect.Success<typeof makeClient>;

class RemoteStateError extends Schema.TaggedError<RemoteStateError>()("RemoteStateError", {
  reason: Schema.String,
}) {}

const error = (operation: NodeDriverError["operation"], cause: unknown) =>
  new NodeDriverError({ operation, message: `Remote board ${operation} failed.`, cause });

const peerFor = Effect.fn("RemoteDriver.peerFor")(function* (
  store: PeerStore,
  thread: { readonly environmentId: BoardDriverThread["environmentId"] },
) {
  const peer = yield* store.get(thread.environmentId);
  if (!peer) return yield* new RemoteStateError({ reason: "Remote environment is not paired." });
  const descriptor = yield* readDescriptor(peer.url);
  if (descriptor.environmentId !== peer.environmentId) {
    return yield* new RemoteStateError({
      reason: "Remote address identifies a different environment.",
    });
  }
  return peer;
});

const connect = Effect.fn("RemoteDriver.connect")(function* (peer: Peer) {
  const response = yield* request(new URL("/api/auth/websocket-ticket/rpc", peer.url), {
    method: "POST",
    headers: { authorization: `Bearer ${peer.bearer}` },
  });
  const ticket = yield* decodeTicket(response);
  const url = new URL("/ws", peer.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket.ticket);
  url.searchParams.set("orchestrationProtocol", ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  const socket = Socket.layerWebSocket(url.toString(), { openTimeout: "10 seconds" }).pipe(
    Layer.provide(NodeSocket.layerWebSocketConstructor),
  );
  const protocol = RpcClient.layerProtocolSocket({
    retryTransientErrors: false,
    retryPolicy: Schedule.recurs(0),
    pingTimeout: "15 seconds",
  }).pipe(Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)));
  const context = yield* Layer.build(protocol);
  return yield* makeClient.pipe(Effect.provide(context));
});

const useClient = <A, E>(
  store: PeerStore,
  target: { readonly environmentId: BoardDriverThread["environmentId"] },
  use: (client: Client) => Effect.Effect<A, E>,
) =>
  Effect.suspend(() => {
    let warned = false;
    return Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* peerFor(store, target);
        const client = yield* connect(peer);
        return yield* use(client);
      }),
    ).pipe(
      Effect.tapError((cause) => {
        if (warned || !retryable(cause)) return Effect.void;
        warned = true;
        return Effect.logWarning("Remote board request disconnected; retrying.", {
          environmentId: target.environmentId,
        });
      }),
      Effect.retry({ while: retryable, times: 3, schedule: Schedule.spaced("1 second") }),
    );
  });

function checkThread(projection: OrchestrationV2ThreadProjection, thread: BoardDriverThread) {
  if (
    projection.thread.projectId !== thread.projectId ||
    projection.thread.id !== thread.threadId
  ) {
    throw new RemoteStateError({
      reason: "Remote thread does not belong to the requested project.",
    });
  }
  return projection;
}

const projectionFor = (client: Client, thread: BoardDriverThread) =>
  client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: thread.threadId }).pipe(
    Effect.flatMap((projection) => Effect.try(() => checkThread(projection, thread))),
  );

const fullProjectionFor = Effect.fn("RemoteDriver.fullProjectionFor")(function* (
  client: Client,
  thread: BoardDriverThread,
) {
  yield* Effect.logWarning("Remote board needs full thread history to find an older run.", {
    environmentId: thread.environmentId,
    threadId: thread.threadId,
  });
  const snapshot = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
    threadId: thread.threadId,
  }).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.runHead,
  );
  if (Option.isNone(snapshot) || snapshot.value.kind !== "snapshot") {
    return yield* new RemoteStateError({ reason: "Remote thread snapshot was not returned." });
  }
  return yield* Effect.try(() => checkThread(snapshot.value.projection, thread));
});

function settled(
  run: OrchestrationV2Run,
  thread: BoardDriverThread,
  sequence: number,
): BoardDriverSettled | undefined {
  switch (run.status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return { thread, runId: run.id, messageId: run.userMessageId, status: run.status, sequence };
    default:
      return undefined;
  }
}

function retryable(cause: unknown): boolean {
  if (isPeerHttpError(cause)) {
    return cause.status === undefined || cause.status === 429 || cause.status >= 500;
  }
  if (typeof cause !== "object" || cause === null) return false;
  if ("_tag" in cause && cause._tag === "RpcClientError") return true;
  return "cause" in cause && retryable(cause.cause);
}

export function make(store: PeerStore): NodeDriver {
  return {
    launch: Effect.fn("RemoteDriver.launch")(function* (input) {
      const result = yield* useClient(store, input, (client) =>
        client[ORCHESTRATION_V2_WS_METHODS.launchThread](input.launch),
      ).pipe(Effect.mapError((cause) => error("launch", cause)));
      return {
        environmentId: input.environmentId,
        projectId: input.launch.projectId,
        threadId: result.threadId,
      };
    }),
    send: Effect.fn("RemoteDriver.send")(function* (input) {
      return yield* useClient(store, input.thread, (client) =>
        Effect.gen(function* () {
          yield* projectionFor(client, input.thread);
          const dispatched = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            commandId: input.commandId,
            threadId: input.thread.threadId,
            messageId: input.messageId,
            text: input.text,
            attachments: [],
            createdBy: "system",
            creationSource: "server",
            dispatchMode: { type: "queue_after_active" },
          });
          const projection = yield* projectionFor(client, input.thread);
          const run =
            projection.runs.find((candidate) => candidate.userMessageId === input.messageId) ??
            (yield* fullProjectionFor(client, input.thread)).runs.find(
              (candidate) => candidate.userMessageId === input.messageId,
            );
          if (!run)
            return yield* new RemoteStateError({
              reason: "Dispatched message has no durable run.",
            });
          return { runId: run.id, sequence: dispatched.sequence };
        }),
      ).pipe(Effect.mapError((cause) => error("send", cause)));
    }),
    subscribeSettled: (input) =>
      Stream.suspend(() => {
        let afterSequence = input.afterSequence;
        let warned = false;
        const delivered = new Map<string, BoardDriverSettled["status"]>();
        const convert = (
          item: OrchestrationV2ThreadStreamItem,
        ): ReadonlyArray<BoardDriverSettled> => {
          let runs: ReadonlyArray<OrchestrationV2Run> = [];
          let sequence: number;
          if (item.kind === "snapshot") {
            checkThread(item.projection, input.thread);
            sequence = item.snapshotSequence;
            runs = item.projection.runs;
          } else if (item.kind === "event" || item.kind === "unknown-event") {
            sequence = item.sequence;
            if (
              item.kind === "event" &&
              (item.event.type === "run.created" || item.event.type === "run.updated")
            ) {
              runs = [item.event.payload];
            }
          } else return [];
          afterSequence = Math.max(afterSequence ?? 0, sequence);
          warned = false;
          return runs.flatMap((run) => {
            const result = settled(run, input.thread, sequence);
            if (!result || delivered.get(run.id) === result.status) return [];
            delivered.set(run.id, result.status);
            return [result];
          });
        };
        const source = Stream.unwrap(
          Effect.gen(function* () {
            const peer = yield* peerFor(store, input.thread);
            const client = yield* connect(peer);
            yield* projectionFor(client, input.thread);
            return client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: input.thread.threadId,
              ...(afterSequence === undefined ? {} : { afterSequence }),
            });
          }),
        ).pipe(
          Stream.mapEffect((item) =>
            Effect.try({
              try: () => convert(item),
              catch: () => new RemoteStateError({ reason: "Invalid remote thread." }),
            }),
          ),
          Stream.flatMap((items) => Stream.fromIterable(items)),
          Stream.concat(Stream.fail(new PeerHttpError({}))),
        );
        return source.pipe(
          Stream.catchIf(retryable, () =>
            Stream.fromEffect(
              Effect.gen(function* () {
                if (!warned) {
                  warned = true;
                  yield* Effect.logWarning(
                    "Remote board subscription disconnected; reconnecting.",
                    { environmentId: input.thread.environmentId, threadId: input.thread.threadId },
                  );
                }
              }),
            ).pipe(Stream.drain),
          ),
          Stream.repeat(Schedule.spaced("1 second")),
          Stream.mapError((cause) => error("subscribeSettled", cause)),
        );
      }),
    readLatestAssistant: Effect.fn("RemoteDriver.readLatestAssistant")(function* (input) {
      return yield* useClient(store, input.thread, (client) =>
        Effect.gen(function* () {
          const select = (projection: OrchestrationV2ThreadProjection) =>
            [...projection.messages]
              .reverse()
              .find(
                (candidate) =>
                  candidate.role === "assistant" &&
                  !candidate.streaming &&
                  (input.runId === undefined || candidate.runId === input.runId),
              );
          const projection = yield* projectionFor(client, input.thread);
          const message =
            select(projection) ?? select(yield* fullProjectionFor(client, input.thread));
          return message ? { id: message.id, text: message.text } : null;
        }),
      ).pipe(Effect.mapError((cause) => error("readLatestAssistant", cause)));
    }),
    interrupt: Effect.fn("RemoteDriver.interrupt")(function* (input) {
      yield* useClient(store, input.thread, (client) =>
        Effect.gen(function* () {
          const projection = yield* projectionFor(client, input.thread);
          const run =
            input.runId === undefined
              ? [...projection.runs]
                  .reverse()
                  .find(
                    (candidate) =>
                      !settled(candidate, input.thread, 0) && candidate.status !== "queued",
                  )
              : (projection.runs.find((candidate) => candidate.id === input.runId) ??
                (yield* fullProjectionFor(client, input.thread)).runs.find(
                  (candidate) => candidate.id === input.runId,
                ));
          if (!run) {
            if (input.runId === undefined) return;
            return yield* new RemoteStateError({ reason: "Remote run was not found." });
          }
          if (settled(run, input.thread, 0)) return;
          if (run.status === "queued") {
            // A queued cancellation and a raced active interrupt need different receipts.
            const cancelled = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "queued-run.cancel",
              commandId: CommandId.make(`${input.commandId}:cancel-queued`),
              threadId: input.thread.threadId,
              runId: run.id,
            }).pipe(Effect.result);
            if (Result.isSuccess(cancelled)) return;
            const refreshed = yield* projectionFor(client, input.thread);
            const current =
              refreshed.runs.find((candidate) => candidate.id === run.id) ??
              (yield* fullProjectionFor(client, input.thread)).runs.find(
                (candidate) => candidate.id === run.id,
              );
            if (!current || current.status === "queued") return yield* cancelled.failure;
            if (settled(current, input.thread, 0)) return;
          }
          yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "run.interrupt",
            commandId: input.commandId,
            threadId: input.thread.threadId,
            runId: run.id,
          });
        }),
      ).pipe(Effect.mapError((cause) => error("interrupt", cause)));
    }),
  };
}
