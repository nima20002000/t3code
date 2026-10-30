import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthWebSocketTicketResult,
  CommandId,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
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
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
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
import { latestContinuation } from "../restartContinuation.ts";
import { PeerHttpError, readDescriptor, request } from "./PeerPairing.ts";
import { makeRestartChain } from "./restartChain.ts";
import type { Peer, PeerStore } from "./PeerStore.ts";

const makeClient = RpcClient.make(WsRpcGroup);
const decodeTicket = Schema.decodeEffect(Schema.toCodecJson(AuthWebSocketTicketResult));
const isPeerHttpError = Schema.is(PeerHttpError);
type Client = Effect.Success<typeof makeClient>;

class RemoteStateError extends Schema.TaggedError<RemoteStateError>()("RemoteStateError", {
  reason: Schema.String,
  defect: Schema.optional(Schema.Defect()),
}) {}

class PeerExpiredError extends Schema.TaggedError<PeerExpiredError>()("PeerExpiredError", {}) {}

/** The paired machine did not answer at all (off, asleep or off the network). */
class PeerUnreachableError extends Schema.TaggedError<PeerUnreachableError>()(
  "PeerUnreachableError",
  { name: Schema.String, cause: Schema.Defect() },
) {}
const isPeerUnreachableError = Schema.is(PeerUnreachableError);

const unreachable = (cause: unknown): PeerUnreachableError | undefined => {
  if (isPeerUnreachableError(cause)) return cause;
  if (typeof cause !== "object" || cause === null || !("cause" in cause)) return undefined;
  return unreachable(cause.cause);
};

const isRemoteStateError = Schema.is(RemoteStateError);

const error = (operation: NodeDriverError["operation"], cause: unknown) =>
  new NodeDriverError({
    operation,
    message: hasTag(cause, "PeerExpiredError")
      ? "Re-pair needed: access to this machine expired."
      : unreachable(cause)
        ? `${unreachable(cause)!.name} is offline or can't be reached.`
        : operation === "deleteProject" && isRemoteStateError(cause)
          ? cause.reason
          : `Remote board ${operation} failed.`,
    ...(retryable(cause) ? { retryable: true } : {}),
    cause,
  });

const reportStatus = Effect.fn("RemoteDriver.reportStatus")(
  function* (
    store: PeerStore,
    target: { readonly environmentId: BoardDriverThread["environmentId"] },
    status: "connected" | "error",
    expectedPeer?: Peer,
  ) {
    if (!store.setStatus) return;
    const peer = expectedPeer ?? (yield* store.get(target.environmentId));
    if (peer) {
      yield* store.setStatus(
        peer,
        status,
        status === "error" ? "Could not reach or authenticate this machine." : undefined,
      );
    }
  },
  (effect, _store, target) =>
    effect.pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not update board machine status", {
          environmentId: target.environmentId,
        }),
      ),
    ),
);

const peerFor = Effect.fn("RemoteDriver.peerFor")(function* (
  store: PeerStore,
  thread: { readonly environmentId: BoardDriverThread["environmentId"] },
  onPeer?: (peer: Peer) => void,
) {
  const peer = yield* store.get(thread.environmentId);
  if (!peer) return yield* new RemoteStateError({ reason: "Remote environment is not paired." });
  if (
    peer.expiresAt !== undefined &&
    Date.parse(peer.expiresAt) <= (yield* DateTime.now).epochMilliseconds
  )
    return yield* new PeerExpiredError({});
  onPeer?.(peer);
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
    let attemptPeer: Peer | undefined;
    return Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* peerFor(store, target, (current) => {
          attemptPeer = current;
        });
        const client = yield* connect(peer);
        const result = yield* use(client);
        yield* reportStatus(store, target, "connected", peer);
        return result;
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
      Effect.tapError((cause) =>
        connectionFailure(cause) ? reportStatus(store, target, "error", attemptPeer) : Effect.void,
      ),
      Effect.mapError((cause) =>
        attemptPeer && noAnswer(cause)
          ? new PeerUnreachableError({ name: attemptPeer.name, cause })
          : cause,
      ),
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

/** No answer from the machine at all, as opposed to an answer that refused the request. */
function noAnswer(cause: unknown): boolean {
  if (isPeerHttpError(cause)) return cause.status === undefined;
  if (typeof cause !== "object" || cause === null) return false;
  if ("_tag" in cause && cause._tag === "RpcClientError") return true;
  return "cause" in cause && noAnswer(cause.cause);
}

function hasTag(cause: unknown, tag: string): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  if ("_tag" in cause && cause._tag === tag) return true;
  return "cause" in cause && hasTag(cause.cause, tag);
}

function connectionFailure(cause: unknown): boolean {
  if (isPeerHttpError(cause)) return true;
  if (typeof cause !== "object" || cause === null) return false;
  if (
    "_tag" in cause &&
    (cause._tag === "RpcClientError" ||
      cause._tag === "PeerPairingError" ||
      cause._tag === "PeerExpiredError")
  )
    return true;
  return "cause" in cause && connectionFailure(cause.cause);
}

export function make(store: PeerStore): NodeDriver {
  return {
    ensureProject: Effect.fn("RemoteDriver.ensureProject")(function* (input) {
      const commandId = CommandId.make(`board:project:${input.projectId}`);
      // A migrated folder has no path: its project already exists on that machine.
      if (input.path === "") return { adopted: true };
      yield* useClient(store, input, (client) =>
        client[WS_METHODS.projectsMutate]({
          type: "project.create",
          commandId,
          projectId: input.projectId,
          title: input.title,
          workspaceRoot: input.path,
          createWorkspaceRootIfMissing: true,
        }),
      ).pipe(Effect.mapError((cause) => error("ensureProject", cause)));
      return { adopted: false };
    }),
    deleteProject: Effect.fn("RemoteDriver.deleteProject")(
      function* (input) {
        if (input.removeFolderPath !== undefined) {
          const path = input.removeFolderPath;
          yield* useClient(store, input, (client) =>
            client[WS_METHODS.projectsRemoveFolder]({ projectId: input.projectId, path }).pipe(
              // A peer on an older t3 reports the unknown method as a defect.
              Effect.catchDefect((defect) =>
                Effect.fail(
                  new RemoteStateError({
                    reason: "Update t3 on that machine to delete folders.",
                    defect,
                  }),
                ),
              ),
            ),
          );
        }
        yield* useClient(store, input, (client) =>
          client[WS_METHODS.projectsMutate]({
            type: "project.delete",
            commandId: CommandId.make(`board:project-delete:${input.projectId}`),
            projectId: input.projectId,
            force: true,
          }),
        );
      },
      Effect.mapError((cause) => error("deleteProject", cause)),
    ),
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
    carryBrowserTabs: Effect.fn("RemoteDriver.carryBrowserTabs")(function* (input) {
      yield* useClient(store, input, (client) =>
        Effect.gen(function* () {
          const { sessions } = yield* client[WS_METHODS.previewList]({ threadId: input.from });
          for (const session of sessions) {
            if (session.runtime !== "server" || session.navStatus._tag === "Idle") continue;
            yield* client[WS_METHODS.previewOpen]({
              threadId: input.to,
              url: session.navStatus.url,
              runtime: "server",
              ...(session.profileId === undefined ? {} : { profileId: session.profileId }),
            });
            yield* client[WS_METHODS.previewClose]({ threadId: input.from, tabId: session.tabId });
          }
        }),
      ).pipe(Effect.mapError((cause) => error("browser", cause)));
    }),
    projectBusy: Effect.fn("RemoteDriver.projectBusy")(function* (input) {
      const first = yield* useClient(store, input, (client) =>
        client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
        ),
      ).pipe(Effect.mapError((cause) => error("projectBusy", cause)));
      return Option.isSome(first) && first.value.kind === "snapshot"
        ? first.value.snapshot.threads.some(
            (thread) => thread.projectId === input.projectId && thread.activeRunId !== null,
          )
        : false;
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
        let statusReported = false;
        let attemptPeer: Peer | undefined;
        const chain = makeRestartChain(input.thread);
        const convert = (
          item: OrchestrationV2ThreadStreamItem,
          now: number,
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
          return runs.flatMap((run) => chain.observe(run, sequence, now));
        };
        const source = Stream.unwrap(
          Effect.gen(function* () {
            const peer = yield* peerFor(store, input.thread, (current) => {
              attemptPeer = current;
            });
            const client = yield* connect(peer);
            yield* projectionFor(client, input.thread);
            chain.connected(yield* Clock.currentTimeMillis);
            const expiries = Stream.tick("5 seconds").pipe(
              Stream.mapEffect(() => Clock.currentTimeMillis.pipe(Effect.map(chain.expire))),
              Stream.flatMap((items) => Stream.fromIterable(items)),
              Stream.map((settle) => ({ settle })),
            );
            // The grace only runs while this connection is up.
            return client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: input.thread.threadId,
              ...(afterSequence === undefined ? {} : { afterSequence }),
            }).pipe(
              Stream.map((item) => ({ item })),
              Stream.merge(expiries, { haltStrategy: "left" }),
            );
          }),
        ).pipe(
          Stream.mapEffect((next) =>
            Effect.gen(function* () {
              if ("settle" in next) return [next.settle];
              const item = next.item;
              const now = yield* Clock.currentTimeMillis;
              const result = yield* Effect.try({
                try: () => convert(item, now),
                catch: () => new RemoteStateError({ reason: "Invalid remote thread." }),
              });
              if (!statusReported) {
                statusReported = true;
                yield* reportStatus(store, input.thread, "connected", attemptPeer);
              }
              return result;
            }),
          ),
          Stream.flatMap((items) => Stream.fromIterable(items)),
          Stream.concat(Stream.fail(new PeerHttpError({}))),
        );
        return source.pipe(
          Stream.catchIf(retryable, () =>
            Stream.fromEffect(
              Effect.gen(function* () {
                statusReported = false;
                yield* reportStatus(store, input.thread, "error", attemptPeer);
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
          Stream.catchIf(connectionFailure, (cause) =>
            Stream.fromEffect(reportStatus(store, input.thread, "error", attemptPeer)).pipe(
              Stream.drain,
              Stream.concat(Stream.fail(cause)),
            ),
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
    getScheduledTask: Effect.fn("RemoteDriver.getScheduledTask")(function* (input) {
      const snapshot = yield* useClient(store, input, (client) =>
        client[WS_METHODS.scheduledTasksSubscribe]({}).pipe(Stream.runHead),
      ).pipe(Effect.mapError((cause) => error("schedule", cause)));
      return Option.isSome(snapshot)
        ? (snapshot.value.tasks.find((task) => task.id === input.taskId) ?? null)
        : null;
    }),
    upsertScheduledTask: Effect.fn("RemoteDriver.upsertScheduledTask")(function* (input) {
      const { task } = yield* useClient(store, input, (client) =>
        client[WS_METHODS.scheduledTasksUpsert]({
          ...input.task,
          createdBy: "system",
          creationSource: "server",
        }),
      ).pipe(Effect.mapError((cause) => error("schedule", cause)));
      return task;
    }),
    setScheduledTaskEnabled: Effect.fn("RemoteDriver.setScheduledTaskEnabled")(function* (input) {
      yield* useClient(store, input, (client) =>
        client[WS_METHODS.scheduledTasksSetEnabled]({ id: input.taskId, enabled: input.enabled }),
      ).pipe(Effect.mapError((cause) => error("schedule", cause)));
    }),
    deleteScheduledTask: Effect.fn("RemoteDriver.deleteScheduledTask")(function* (input) {
      yield* useClient(store, input, (client) =>
        client[WS_METHODS.scheduledTasksDelete]({ id: input.taskId }),
      ).pipe(Effect.mapError((cause) => error("schedule", cause)));
    }),
    interrupt: Effect.fn("RemoteDriver.interrupt")(function* (input) {
      yield* useClient(store, input.thread, (client) =>
        Effect.gen(function* () {
          if (input.runId === undefined) {
            // The send's run is unknown: stop whatever the thread runs and any continuation it owes.
            yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.stop",
              commandId: input.commandId,
              threadId: input.thread.threadId,
            });
            return;
          }
          const projection = yield* projectionFor(client, input.thread);
          const runs = projection.runs.some((candidate) => candidate.id === input.runId)
            ? projection.runs
            : (yield* fullProjectionFor(client, input.thread)).runs;
          const found = runs.find((candidate) => candidate.id === input.runId);
          if (!found) return yield* new RemoteStateError({ reason: "Remote run was not found." });
          // A restart may have cut the run and continued it; Stop reaches the continuation.
          const run = latestContinuation(runs, found);
          if (
            run.status === "cancelled" &&
            (run.startedAt !== null || run.restartContinuationOfRunId !== undefined)
          ) {
            // Its continuation may still be pending on the machine; a thread Stop declines it.
            yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.stop",
              commandId: input.commandId,
              threadId: input.thread.threadId,
            });
            return;
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
