// @effect-diagnostics nodeBuiltinImport:off -- Observe the isolated server's atomic readiness file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import * as ServerConfig from "../../config.ts";
import * as Server from "../../server.ts";
import * as PeerPairing from "./PeerPairing.ts";
import * as PeerStore from "./PeerStore.ts";
import * as RemoteDriver from "./RemoteDriver.ts";
import * as FakeCodex from "./FakeCodexTransport.testkit.ts";

vi.mock("../../orchestration-v2/Adapters/CodexAdapterV2.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../orchestration-v2/Adapters/CodexAdapterV2.ts")>();
  const fake = await import("./FakeCodexTransport.testkit.ts");
  return {
    ...original,
    layerAppServerClientFactory: fake.layer(original.CodexAppServerClientFactory),
  };
});

const devToken = "board-test-reusable-token-with-sufficient-length";
class TestServerError extends Schema.TaggedError<TestServerError>()("TestServerError", {
  cause: Schema.Defect(),
}) {}
const readyFile = (path: string) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        const watcher = NodeFS.watch(NodePath.dirname(path), (event, name) => {
          if (event !== "rename" || name !== NodePath.basename(path)) return;
          NodeFS.readFile(path, "utf8", (cause, contents) => {
            if (cause) return reject(cause);
            watcher.close();
            resolve(contents);
          });
        });
        signal.addEventListener("abort", () => watcher.close(), { once: true });
        watcher.on("error", reject);
      }),
    catch: (cause) => new TestServerError({ cause }),
  });

const testClient = Effect.fn("RemoteSeam.testClient")(function* (peer: PeerStore.Peer) {
  const body = yield* PeerPairing.request(new URL("/api/auth/websocket-ticket/rpc", peer.url), {
    method: "POST",
    headers: { authorization: `Bearer ${peer.bearer}` },
  });
  const ticket = (body as { ticket: string }).ticket;
  const url = new URL("/ws", peer.url);
  url.protocol = "ws:";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  const protocol = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(url.toString()).pipe(
          Layer.provide(NodeSocket.layerWebSocketConstructor),
        ),
        RpcSerialization.layerJson,
      ),
    ),
  );
  const context = yield* Layer.build(protocol);
  return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(context));
});

it.live("pairs and drives a second real server over authenticated RPC", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const configContext = yield* Layer.build(
        ServerConfig.layerTest(process.cwd(), { prefix: "board-remote-seam-" }),
      );
      const base = Context.get(configContext, ServerConfig.ServerConfig);
      const config = {
        ...base,
        cwd: base.baseDir,
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(devToken),
        noBrowser: true,
        shellEnvironmentPrepared: true,
      };
      const waiting = yield* Effect.forkScoped(readyFile(config.serverRuntimeStatePath));
      const serverFiber = yield* Server.runServer.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provide(NodeServices.layer),
        Effect.forkScoped,
      );
      const contents = yield* Effect.raceFirst(
        Fiber.join(waiting),
        Fiber.await(serverFiber).pipe(Effect.flatMap((exit) => Effect.die(exit))),
      );
      const origin = (JSON.parse(contents) as { origin: string }).origin;
      const admin = yield* PeerPairing.request(new URL("/oauth/token", origin), {
        method: "POST",
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: devToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
      const http = yield* HttpClient.HttpClient;
      const pairingResponse = yield* http.execute(
        HttpClientRequest.post(`${origin}/api/auth/pairing-token`).pipe(
          HttpClientRequest.setHeader(
            "authorization",
            `Bearer ${(admin as { access_token: string }).access_token}`,
          ),
          HttpClientRequest.bodyJsonUnsafe({
            scopes: ["orchestration:read", "orchestration:operate"],
          }),
        ),
      );
      assert.equal(pairingResponse.status, 200);
      const pairing = (yield* pairingResponse.json) as { credential: string };
      const store = PeerStore.makeMemory();
      const peer = yield* PeerPairing.pair({
        name: "Second server",
        pairingUrlOrCode: `${origin}/pair#token=${pairing.credential}`,
        store,
      });
      const driver = RemoteDriver.make(store);
      const projectId = ProjectId.make("board-remote-project");
      const threadId = ThreadId.make("board-remote-thread");
      const client = yield* testClient(peer);
      yield* client[WS_METHODS.projectsMutate]({
        type: "project.create",
        commandId: CommandId.make("board-test-project"),
        projectId,
        title: "Remote project",
        workspaceRoot: config.cwd,
      });
      const thread = yield* driver.launch({
        environmentId: peer.environmentId,
        launch: {
          commandId: CommandId.make("board-test-launch"),
          projectId,
          threadId,
          title: "Board node",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        },
      });
      assert.equal(thread.threadId, threadId);
      const sent = yield* driver.send({
        thread,
        commandId: CommandId.make("board-test-send"),
        messageId: MessageId.make("board-test-message"),
        text: "finish",
      });
      const replay = yield* driver.send({
        thread,
        commandId: CommandId.make("board-test-send"),
        messageId: MessageId.make("board-test-message"),
        text: "finish",
      });
      assert.equal(replay.runId, sent.runId);
      const replayProjection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId,
      });
      assert.lengthOf(
        replayProjection.runs.filter(
          (run) => run.userMessageId === MessageId.make("board-test-message"),
        ),
        1,
      );
      const [completed] = yield* driver
        .subscribeSettled({ thread, afterSequence: sent.sequence })
        .pipe(
          Stream.filter((event) => event.runId === sent.runId),
          Stream.take(1),
          Stream.runCollect,
        );
      assert.equal(completed?.status, "completed");
      assert.equal(
        (yield* driver.readLatestAssistant({ thread, runId: sent.runId }))?.text,
        "fake result",
      );
      const subscribed = yield* Deferred.make<WebSocket>();
      const reconnected = yield* Deferred.make<number | undefined>();
      const queuedCancel = yield* Deferred.make<() => void>();
      const originalWebSocket = globalThis.WebSocket;
      const resumeSequences: Array<number | undefined> = [];
      class ObservedWebSocket extends originalWebSocket {
        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          const frame =
            typeof data === "string"
              ? data
              : data instanceof Uint8Array
                ? new TextDecoder().decode(data)
                : "";
          if (frame.includes("board-test-race-cancel:cancel-queued")) {
            Deferred.doneUnsafe(
              queuedCancel,
              Effect.succeed(() => super.send(data)),
            );
            return;
          }
          super.send(data);
          if (frame.includes(ORCHESTRATION_V2_WS_METHODS.subscribeThread)) {
            const request = JSON.parse(frame) as { payload: { afterSequence?: number } };
            resumeSequences.push(request.payload.afterSequence);
            Deferred.doneUnsafe(subscribed, Effect.succeed(this));
            if (resumeSequences.length === 2)
              Deferred.doneUnsafe(reconnected, Effect.succeed(request.payload.afterSequence));
          }
        }
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          globalThis.WebSocket = ObservedWebSocket;
        }),
        () =>
          Effect.sync(() => {
            globalThis.WebSocket = originalWebSocket;
          }),
      );
      const replayedCompletion = yield* Deferred.make<number>();
      const waitingForHeld = yield* driver
        .subscribeSettled({ thread, afterSequence: sent.sequence })
        .pipe(
          Stream.tap((event) =>
            event.runId === sent.runId
              ? Deferred.succeed(replayedCompletion, event.sequence).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Stream.filter((event) => event.messageId === MessageId.make("board-test-hold-message")),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
      const firstSocket = yield* Deferred.await(subscribed);
      const replayedSequence = yield* Deferred.await(replayedCompletion);
      yield* Effect.sync(() => firstSocket.close(4000, "test reconnect"));
      const held = yield* driver.send({
        thread,
        commandId: CommandId.make("board-test-hold"),
        messageId: MessageId.make("board-test-hold-message"),
        text: "hold",
      });
      yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId,
        afterSequence: held.sequence,
      }).pipe(
        Stream.filter(
          (item) =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.id === held.runId &&
            item.event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const resumedAfter = yield* Deferred.await(reconnected);
      const queued = yield* driver.send({
        thread,
        commandId: CommandId.make("board-test-queued"),
        messageId: MessageId.make("board-test-queued-message"),
        text: "queued",
      });
      const queuedProjection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId,
      });
      assert.equal(queuedProjection.runs.find((run) => run.id === queued.runId)?.status, "queued");
      yield* driver.interrupt({
        thread,
        runId: queued.runId,
        commandId: CommandId.make("board-test-cancel-queued"),
      });
      const [cancelled] = yield* driver
        .subscribeSettled({ thread, afterSequence: queued.sequence })
        .pipe(
          Stream.filter((event) => event.runId === queued.runId),
          Stream.take(1),
          Stream.runCollect,
        );
      assert.equal(cancelled?.status, "cancelled");
      const raced = yield* driver.send({
        thread,
        commandId: CommandId.make("board-test-race"),
        messageId: MessageId.make("board-test-race-message"),
        text: "race",
      });
      const cancellingRaced = yield* driver
        .interrupt({
          thread,
          runId: raced.runId,
          commandId: CommandId.make("board-test-race-cancel"),
        })
        .pipe(Effect.forkScoped);
      const releaseQueuedCancel = yield* Deferred.await(queuedCancel);
      yield* driver.interrupt({
        thread,
        runId: held.runId,
        commandId: CommandId.make("board-test-interrupt"),
      });
      const [interrupted] = yield* Fiber.join(waitingForHeld);
      assert.equal(interrupted?.status, "interrupted");
      yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId,
        afterSequence: raced.sequence,
      }).pipe(
        Stream.filter(
          (item) =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.id === raced.runId &&
            item.event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* Effect.sync(releaseQueuedCancel);
      yield* Fiber.join(cancellingRaced);
      const [racedInterrupt] = yield* driver
        .subscribeSettled({ thread, afterSequence: raced.sequence })
        .pipe(
          Stream.filter((event) => event.runId === raced.runId),
          Stream.take(1),
          Stream.runCollect,
        );
      assert.equal(racedInterrupt?.status, "interrupted");
      assert.isAtLeast(resumeSequences.length, 2);
      assert.equal(resumeSequences[0], sent.sequence);
      assert.isAbove(replayedSequence, sent.sequence);
      assert.isAtLeast(resumedAfter ?? 0, replayedSequence);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
  ),
);

/** A paired real server with a held turn running, then shut down mid-turn; restart starts it again. */
const heldTurnServer = Effect.fn("RemoteSeam.heldTurnServer")(function* (prefix: string) {
  const configContext = yield* Layer.build(ServerConfig.layerTest(process.cwd(), { prefix }));
  const base = Context.get(configContext, ServerConfig.ServerConfig);
  const config = {
    ...base,
    cwd: base.baseDir,
    devUrl: new URL("http://127.0.0.1:5173"),
    devAuthToken: Redacted.make(devToken),
    noBrowser: true,
    shellEnvironmentPrepared: true,
  };
  const start = Effect.fn("RemoteSeam.start")(function* (scope: Scope.Scope) {
    const waiting = yield* Effect.forkIn(readyFile(config.serverRuntimeStatePath), scope);
    const serverFiber = yield* Server.runServer.pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provide(NodeServices.layer),
      Effect.forkIn(scope),
    );
    const contents = yield* Effect.raceFirst(
      Fiber.join(waiting),
      Fiber.await(serverFiber).pipe(Effect.flatMap((exit) => Effect.die(exit))),
    );
    return (JSON.parse(contents) as { origin: string }).origin;
  });
  const firstScope = yield* Scope.make();
  const origin = yield* start(firstScope);
  const admin = yield* PeerPairing.request(new URL("/oauth/token", origin), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: devToken,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
    }),
  });
  const http = yield* HttpClient.HttpClient;
  const pairingResponse = yield* http.execute(
    HttpClientRequest.post(`${origin}/api/auth/pairing-token`).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        `Bearer ${(admin as { access_token: string }).access_token}`,
      ),
      HttpClientRequest.bodyJsonUnsafe({
        scopes: ["orchestration:read", "orchestration:operate"],
      }),
    ),
  );
  const pairing = (yield* pairingResponse.json) as { credential: string };
  const store = PeerStore.makeMemory();
  const peer = yield* PeerPairing.pair({
    name: "Restarting server",
    pairingUrlOrCode: `${origin}/pair#token=${pairing.credential}`,
    store,
  });
  const driver = RemoteDriver.make(store);
  const projectId = ProjectId.make("board-restart-project");
  const threadId = ThreadId.make("board-restart-thread");
  yield* driver.ensureProject({
    environmentId: peer.environmentId,
    projectId,
    title: "Restart project",
    path: config.cwd,
  });
  const thread = yield* driver.launch({
    environmentId: peer.environmentId,
    launch: {
      commandId: CommandId.make("board-restart-launch"),
      projectId,
      threadId,
      title: "Board node",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    },
  });
  const warm = yield* driver.send({
    thread,
    commandId: CommandId.make("board-restart-warm"),
    messageId: MessageId.make("board-restart-warm-message"),
    text: "finish",
  });
  yield* driver.subscribeSettled({ thread, afterSequence: warm.sequence }).pipe(
    Stream.filter((event) => event.runId === warm.runId),
    Stream.runHead,
  );
  const held = yield* driver.send({
    thread,
    commandId: CommandId.make("board-restart-hold"),
    messageId: MessageId.make("board-restart-hold-message"),
    text: "hold",
  });
  const client = yield* testClient(peer);
  yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
    threadId,
    afterSequence: held.sequence,
  }).pipe(
    Stream.filter(
      (item) =>
        item.kind === "event" &&
        item.event.type === "provider-turn.updated" &&
        item.event.payload.status === "running",
    ),
    Stream.runHead,
  );
  yield* Scope.close(firstScope, Exit.void);
  const restart = Effect.gen(function* () {
    const secondScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
    const restarted = yield* start(secondScope);
    yield* store.put({ ...peer, url: restarted });
    return restarted;
  });
  return { driver, peer, thread, threadId, held, restart };
});

it.live("continues a turn the machine's restart cut off, once, in the same thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { driver, peer, thread, threadId, held, restart } = yield* heldTurnServer(
        "board-remote-restart-seam-",
      );
      const restarted = yield* restart;

      // The board only follows: t3 on the restarted machine continues the cut turn itself.
      const [continued] = yield* driver
        .subscribeSettled({ thread, afterSequence: held.sequence })
        .pipe(
          Stream.filter(
            (event) => event.messageId === MessageId.make("board-restart-hold-message"),
          ),
          Stream.take(1),
          Stream.runCollect,
        );
      assert.equal(continued?.status, "completed");
      assert.notEqual(continued?.runId, held.runId);
      assert.equal(
        (yield* driver.readLatestAssistant({ thread, runId: continued!.runId }))?.text,
        "fake result",
      );
      const projection = yield* (yield* testClient({ ...peer, url: restarted }))[
        ORCHESTRATION_V2_WS_METHODS.getThreadProjection
      ]({ threadId });
      assert.deepEqual(
        projection.runs
          .filter((run) => run.restartContinuationOfRunId === held.runId)
          .map((run) => run.id),
        [continued!.runId],
      );
      assert.lengthOf(projection.runs, 3);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
  ),
);

it.live("a Stop sent while the machine is down keeps t3's continuation from finishing a turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { driver, peer, thread, threadId, held, restart } =
        yield* heldTurnServer("board-remote-stop-seam-");
      // A continuation that would otherwise reply stays running until something stops it.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          FakeCodex.fakeTurns.completeFirst = false;
        }),
        () =>
          Effect.sync(() => {
            FakeCodex.fakeTurns.completeFirst = true;
          }),
      );
      // As the board engine does, keep retrying the Stop while the machine is away.
      const stopping = yield* driver
        .interrupt({ thread, runId: held.runId, commandId: CommandId.make("board-stop-away") })
        .pipe(Effect.retry({ while: (cause) => cause.retryable === true }), Effect.forkScoped);
      const restarted = yield* restart;
      yield* Fiber.join(stopping);
      const client = yield* testClient({ ...peer, url: restarted });
      const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
      const settled = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }).pipe(
        Stream.mapEffect(() =>
          client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId }),
        ),
        Stream.filter((projection) => projection.runs.every((run) => terminal.has(run.status))),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(settled));
      if (Option.isSome(settled))
        assert.deepEqual(
          settled.value.runs
            .filter((run) => run.status === "completed")
            .map((run) => run.userMessageId),
          [MessageId.make("board-restart-warm-message")],
        );
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
  ),
);
