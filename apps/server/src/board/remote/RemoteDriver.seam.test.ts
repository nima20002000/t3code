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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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
      const originalWebSocket = globalThis.WebSocket;
      const resumeSequences: Array<number | undefined> = [];
      class ObservedWebSocket extends originalWebSocket {
        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          super.send(data);
          const frame =
            typeof data === "string"
              ? data
              : data instanceof Uint8Array
                ? new TextDecoder().decode(data)
                : "";
          if (frame.includes(ORCHESTRATION_V2_WS_METHODS.subscribeThread)) {
            const request = JSON.parse(frame) as { payload: { afterSequence?: number } };
            resumeSequences.push(request.payload.afterSequence);
            Deferred.doneUnsafe(subscribed, Effect.succeed(this));
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
      yield* driver.interrupt({
        thread,
        runId: held.runId,
        commandId: CommandId.make("board-test-interrupt"),
      });
      const [interrupted] = yield* Fiber.join(waitingForHeld);
      assert.equal(interrupted?.status, "interrupted");
      assert.isAtLeast(resumeSequences.length, 2);
      assert.equal(resumeSequences[0], sent.sequence);
      assert.isAbove(replayedSequence, sent.sequence);
      assert.isAtLeast(resumeSequences[1] ?? 0, replayedSequence);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
  ),
);
