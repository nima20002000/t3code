// @effect-diagnostics nodeBuiltinImport:off -- Watch the isolated server's readiness file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { createWorkflow } from "@t3tools/board-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as Server from "../server.ts";
import * as FakeTransport from "./FakeBoardTransport.testkit.ts";

vi.mock("../orchestration-v2/Adapters/CodexAdapterV2.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../orchestration-v2/Adapters/CodexAdapterV2.ts")>();
  const fake = await import("./FakeBoardTransport.testkit.ts");
  return {
    ...original,
    layerAppServerClientFactory: fake.layer(original.CodexAppServerClientFactory),
  };
});

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

it.live("runs a board request and interrupts through the real server and orchestration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("board-engine-seam");
      const configContext = yield* Layer.build(
        ServerConfig.layerTest(cwd, { prefix: "board-engine-seam-" }),
      );
      const base = Context.get(configContext, ServerConfig.ServerConfig);
      const token = "board-engine-test-token-with-sufficient-length";
      const config = {
        ...base,
        cwd,
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(token),
        noBrowser: true,
        shellEnvironmentPrepared: true,
      };
      const waiting = yield* Effect.forkScoped(readyFile(config.serverRuntimeStatePath));
      const server = yield* Server.runServer.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provide(NodeServices.layer),
        Effect.forkScoped,
      );
      const origin = (
        JSON.parse(
          yield* Effect.raceFirst(
            Fiber.join(waiting),
            Fiber.await(server).pipe(Effect.flatMap((exit) => Effect.die(exit))),
          ),
        ) as { origin: string }
      ).origin;

      const request = (path: string, init?: RequestInit) =>
        // @effect-diagnostics-next-line globalFetchInEffect:off -- Inspect the real HTTP response and SSE body.
        Effect.tryPromise(() => fetch(`${origin}${path}`, init));
      assert.strictEqual((yield* request("/api/board/snapshot")).status, 401);
      const descriptorResponse = yield* request("/.well-known/t3/environment");
      const descriptor = (yield* Effect.tryPromise(() => descriptorResponse.json())) as {
        environmentId: string;
      };
      const auth = yield* request("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: token,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
      assert.strictEqual(auth.status, 200);
      const bearer = ((yield* Effect.tryPromise(() => auth.json())) as { access_token: string })
        .access_token;
      const authorization = { authorization: `Bearer ${bearer}` };
      assert.strictEqual(
        (yield* request("/api/board/snapshot", { headers: authorization })).status,
        200,
      );
      const ticketResponse = yield* request("/api/auth/websocket-ticket/rpc", {
        method: "POST",
        headers: authorization,
      });
      assert.strictEqual(ticketResponse.status, 200);
      const ticket = ((yield* Effect.tryPromise(() => ticketResponse.json())) as { ticket: string })
        .ticket;
      const ws = new URL("/ws", origin);
      ws.protocol = "ws:";
      ws.searchParams.set("wsTicket", ticket);
      ws.searchParams.set("orchestrationProtocol", "2");
      const protocol = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(ws.toString()).pipe(
              Layer.provide(NodeSocket.layerWebSocketConstructor),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      );
      const rpcContext = yield* Layer.build(protocol);
      const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(rpcContext));
      const projectId = ProjectId.make("board-seam-project");
      yield* client[WS_METHODS.projectsMutate]({
        type: "project.create",
        commandId: CommandId.make("board-seam-project-create"),
        projectId,
        title: "Board seam",
        workspaceRoot: cwd,
      });
      const post = (path: string, body: unknown) =>
        request(path, {
          method: "POST",
          headers: { ...authorization, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const remoteContext = yield* Layer.build(
        ServerConfig.layerTest(cwd, { prefix: "board-peer-seam-" }),
      );
      const remoteBase = Context.get(remoteContext, ServerConfig.ServerConfig);
      const remoteConfig = {
        ...remoteBase,
        cwd,
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(token),
        noBrowser: true,
        shellEnvironmentPrepared: true,
      };
      const remoteReady = yield* Effect.forkScoped(readyFile(remoteConfig.serverRuntimeStatePath));
      const remoteServer = yield* Server.runServer.pipe(
        Effect.provideService(ServerConfig.ServerConfig, remoteConfig),
        Effect.provide(NodeServices.layer),
        Effect.forkScoped,
      );
      const remoteOrigin = (
        JSON.parse(
          yield* Effect.raceFirst(
            Fiber.join(remoteReady),
            Fiber.await(remoteServer).pipe(Effect.flatMap((exit) => Effect.die(exit))),
          ),
        ) as { origin: string }
      ).origin;
      const remoteRequest = (path: string, init?: RequestInit) =>
        // @effect-diagnostics-next-line globalFetchInEffect:off -- Exercise pairing and HTTP against the second isolated server.
        Effect.tryPromise(() => fetch(`${remoteOrigin}${path}`, init));
      const remoteDescriptorResponse = yield* remoteRequest("/.well-known/t3/environment");
      const remoteDescriptor = (yield* Effect.tryPromise(() => remoteDescriptorResponse.json())) as {
        environmentId: string;
      };
      assert.notStrictEqual(remoteDescriptor.environmentId, descriptor.environmentId);
      const remoteAuth = yield* remoteRequest("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: token,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
      assert.strictEqual(remoteAuth.status, 200);
      const remoteBearer = ((yield* Effect.tryPromise(() => remoteAuth.json())) as {
        access_token: string;
      }).access_token;
      const remoteAuthorization = { authorization: `Bearer ${remoteBearer}` };
      const makePairing = Effect.fn("BoardSeam.makePairing")(function* () {
        const response = yield* remoteRequest("/api/auth/pairing-token", {
          method: "POST",
          headers: { ...remoteAuthorization, "content-type": "application/json" },
          body: JSON.stringify({ scopes: ["orchestration:read", "orchestration:operate"] }),
        });
        assert.strictEqual(response.status, 200);
        return ((yield* Effect.tryPromise(() => response.json())) as { credential: string })
          .credential;
      });
      const code = yield* makePairing();
      const paired = yield* post("/api/board/peers", {
        name: "Second machine",
        pairingUrlOrCode: code,
        host: remoteOrigin,
      });
      assert.strictEqual(paired.status, 200);
      const pairedBody = yield* Effect.tryPromise(() => paired.text());
      assert.notInclude(pairedBody, "bearer");
      const peer = JSON.parse(pairedBody) as { id: string; environmentId: string };
      assert.strictEqual(peer.environmentId, remoteDescriptor.environmentId);
      const nextCode = yield* makePairing();
      assert.strictEqual(
        (yield* post("/api/board/peers", {
          name: "Second machine",
          pairingUrlOrCode: `${remoteOrigin}/pair#token=${nextCode}`,
        })).status,
        200,
      );
      assert.strictEqual(
        (yield* post("/api/board/peers", {
          name: "Hub",
          pairingUrlOrCode: `${origin}/pair#token=unused`,
        })).status,
        400,
      );
      const peerListResponse = yield* request("/api/board/peers", { headers: authorization });
      const peerListText = yield* Effect.tryPromise(() => peerListResponse.text());
      assert.strictEqual((JSON.parse(peerListText) as unknown[]).length, 1);
      assert.notInclude(peerListText, "bearer");
      const peerEventsResponse = yield* request("/api/board/events?afterSequence=0", {
        headers: authorization,
      });
      const peerReader = peerEventsResponse.body!.getReader();
      const peerFrame = yield* Effect.tryPromise(() => peerReader.read());
      const peerFrameText = new TextDecoder().decode(peerFrame.value);
      assert.include(peerFrameText, '"kind":"peer.upserted"');
      assert.notInclude(peerFrameText, "bearer");
      yield* Effect.promise(() => peerReader.cancel());

      const remoteTicketResponse = yield* remoteRequest("/api/auth/websocket-ticket/rpc", {
        method: "POST",
        headers: remoteAuthorization,
      });
      const remoteTicket = ((yield* Effect.tryPromise(() => remoteTicketResponse.json())) as {
        ticket: string;
      }).ticket;
      const remoteWs = new URL("/ws", remoteOrigin);
      remoteWs.protocol = "ws:";
      remoteWs.searchParams.set("wsTicket", remoteTicket);
      remoteWs.searchParams.set("orchestrationProtocol", "2");
      const remoteProtocol = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(remoteWs.toString()).pipe(
              Layer.provide(NodeSocket.layerWebSocketConstructor),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      );
      const remoteRpcContext = yield* Layer.build(remoteProtocol);
      const remoteClient = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(remoteRpcContext));
      yield* remoteClient[WS_METHODS.projectsMutate]({
        type: "project.create",
        commandId: CommandId.make("board-seam-remote-project-create"),
        projectId,
        title: "Remote board seam",
        workspaceRoot: cwd,
      });

      assert.strictEqual(
        (yield* post("/api/board/workflows/import", {
          workflows: [createWorkflow("imported", "Imported")],
        })).status,
        200,
      );
      assert.strictEqual(
        (yield* post("/api/board/workflows", { id: "workflow", name: "Workflow" })).status,
        200,
      );
      for (const [id, name] of [
        ["root", "Root"],
        ["child", "Child"],
      ] as const) {
        const response = yield* post("/api/board/workflows/workflow/nodes", {
          kind: "launch",
          id,
          name,
          environmentId: id === "child" ? remoteDescriptor.environmentId : descriptor.environmentId,
          projectId,
          threadId: `board-seam-${id}`,
          modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          x: 0,
          y: 0,
        });
        assert.strictEqual(response.status, 200);
      }
      const rootThread = ThreadId.make("board-seam-root");
      const threadSequence = Effect.fn("BoardSeam.threadSequence")(function* () {
        const snapshot = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId: rootThread,
        }).pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        if (snapshot.kind !== "snapshot") return yield* Effect.die("Expected thread snapshot");
        return snapshot.snapshotSequence;
      });
      const beforeBriefing = yield* threadSequence();
      assert.strictEqual(
        (yield* post("/api/board/workflows/workflow/edges", { a: "root", b: "child" })).status,
        200,
      );
      assert.strictEqual(
        (yield* post("/api/board/schedules", {
          id: "remote-schedule",
          workflowId: "workflow",
          nodeId: "child",
          task: "Scheduled remote work",
          everyMs: 60_000,
          enabled: true,
        })).status,
        200,
      );
      const pausedSchedule = yield* request("/api/board/schedules/remote-schedule", {
        method: "PATCH",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      assert.strictEqual(pausedSchedule.status, 200);
      const paused = (yield* Effect.tryPromise(() => pausedSchedule.json())) as {
        enabled: boolean;
        nextRunAt: string | null;
      };
      assert.strictEqual(paused.enabled, false);
      assert.isNull(paused.nextRunAt);
      const briefing = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId: rootThread,
        afterSequence: beforeBriefing,
      }).pipe(
        Stream.filter(
          (item) =>
            item.kind === "event" &&
            item.event.type === "message.updated" &&
            item.event.payload.text.includes("You can send requests to:\n- Child"),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      if (briefing.kind !== "event" || briefing.event.type !== "message.updated")
        return yield* Effect.die("Expected board briefing");
      const briefingRunId = briefing.event.payload.runId;
      yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId: rootThread,
        afterSequence: briefing.sequence,
      }).pipe(
        Stream.filter(
          (item) =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.id === briefingRunId &&
            item.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const beforeRun = yield* request("/api/board/workflows/workflow", { headers: authorization });
      const beforeRunData = (yield* Effect.tryPromise(() => beforeRun.json())) as {
        runs: ReadonlyArray<unknown>;
      };
      assert.deepStrictEqual(beforeRunData.runs, []);
      const events = yield* request("/api/board/events?afterSequence=0", {
        headers: authorization,
      });
      assert.strictEqual(events.status, 200);
      assert.include(events.headers.get("content-type"), "text/event-stream");
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => events.body!.getReader()),
        (streamReader) => Effect.promise(() => streamReader.cancel()).pipe(Effect.ignore),
      );
      let buffer = "";
      const decoder = new TextDecoder();
      const waitForRun = (runId: string, status: string) =>
        Effect.tryPromise(async () => {
          while (true) {
            const frameEnd = buffer.indexOf("\n\n");
            if (frameEnd >= 0) {
              const frame = buffer.slice(0, frameEnd);
              buffer = buffer.slice(frameEnd + 2);
              const data = frame.split("\n").find((line) => line.startsWith("data:"));
              if (!data) continue;
              const event = JSON.parse(data.slice(5).trim()) as {
                kind: string;
                run?: {
                  id: string;
                  status: string;
                  summary?: string;
                  requests: ReadonlyArray<{ status: string }>;
                };
              };
              if (
                event.kind === "run.upserted" &&
                event.run?.id === runId &&
                event.run.status === status
              )
                return event.run;
              continue;
            }
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Board event stream closed");
            buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
          }
        });
      assert.strictEqual(
        (yield* post("/api/board/workflows/workflow/runs", {
          id: "run",
          nodeId: "root",
          task: "Delegate",
        })).status,
        200,
      );
      const completed = yield* waitForRun("run", "finished");
      assert.strictEqual(completed.summary, "run finished");
      assert.deepStrictEqual(
        completed.requests.map((entry) => entry.status),
        ["returned"],
      );
      assert.strictEqual(
        (yield* post("/api/board/workflows/workflow/runs", {
          id: "held",
          nodeId: "root",
          task: "Hold this run",
        })).status,
        200,
      );
      yield* Effect.promise(() => FakeTransport.held.promise);
      const beforeQueued = yield* threadSequence();
      assert.strictEqual(
        (yield* post("/api/board/workflows/workflow/runs", {
          id: "queued",
          nodeId: "root",
          task: "Queued task",
        })).status,
        200,
      );
      const threadId = rootThread;
      const queuedEvent = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId,
        afterSequence: beforeQueued,
      }).pipe(
        Stream.filter(
          (item) =>
            item.kind === "event" &&
            item.event.type === "message.updated" &&
            item.event.payload.text.includes("Queued task"),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.isTrue(queuedEvent.kind === "event" && queuedEvent.event.type === "message.updated");
      if (queuedEvent.kind !== "event" || queuedEvent.event.type !== "message.updated")
        return yield* Effect.die("Expected queued message");
      const queuedRunId = queuedEvent.event.payload.runId;
      assert.isNotNull(queuedRunId);
      const beforeCancel = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId,
      });
      assert.strictEqual(beforeCancel.runs.find((run) => run.id === queuedRunId)?.status, "queued");
      assert.strictEqual(
        (yield* post("/api/board/workflows/workflow/runs/queued/stop", {})).status,
        200,
      );
      const cancelled = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId,
        afterSequence: queuedEvent.sequence,
      }).pipe(
        Stream.filter(
          (item) =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.id === queuedRunId &&
            item.event.payload.status === "cancelled",
        ),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(cancelled));
      assert.strictEqual(
        (yield* post("/api/board/workflows/workflow/runs/held/stop", {})).status,
        200,
      );
      yield* Effect.promise(() => FakeTransport.interrupted.promise);
      yield* waitForRun("held", "stopped");

      const remoteThread = ThreadId.make("board-seam-child");
      const remoteSnapshot = yield* remoteClient[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId: remoteThread,
      }).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      if (remoteSnapshot.kind !== "snapshot") return yield* Effect.die("Expected remote snapshot");
      assert.strictEqual(
        (yield* post("/api/board/workflows/workflow/runs", {
          id: "remote-held",
          nodeId: "child",
          task: "Hold this run remotely",
        })).status,
        200,
      );
      const remoteMessage = yield* remoteClient[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId: remoteThread,
        afterSequence: remoteSnapshot.snapshotSequence,
      }).pipe(
        Stream.filter(
          (item) =>
            item.kind === "event" &&
            item.event.type === "message.updated" &&
            item.event.payload.text.includes("Hold this run remotely"),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      if (remoteMessage.kind !== "event" || remoteMessage.event.type !== "message.updated")
        return yield* Effect.die("Expected remote message");
      const remoteRunId = remoteMessage.event.payload.runId;
      assert.isNotNull(remoteRunId);
      yield* remoteClient[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId: remoteThread,
        afterSequence: remoteSnapshot.snapshotSequence,
      }).pipe(
        Stream.filter(
          (item) =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.id === remoteRunId &&
            item.event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.strictEqual(
        (yield* post("/api/board/workflows/workflow/runs/remote-held/stop", {})).status,
        200,
      );
      yield* waitForRun("remote-held", "stopped");
      yield* remoteClient[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId: remoteThread,
        afterSequence: remoteSnapshot.snapshotSequence,
      }).pipe(
        Stream.filter(
          (item) =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.id === remoteRunId &&
            ["interrupted", "cancelled"].includes(item.event.payload.status),
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const snapshotBeforeRemoval = yield* request("/api/board/snapshot", {
        headers: authorization,
      });
      const { sequence } = (yield* Effect.tryPromise(() => snapshotBeforeRemoval.json())) as {
        sequence: number;
      };
      const deletedPeer = yield* request(`/api/board/peers/${peer.id}`, {
        method: "DELETE",
        headers: authorization,
      });
      assert.strictEqual(deletedPeer.status, 204);
      const afterRemoval = yield* request("/api/board/peers", { headers: authorization });
      assert.deepStrictEqual(yield* Effect.tryPromise(() => afterRemoval.json()), []);
      const removalEvents = yield* request(`/api/board/events?afterSequence=${sequence}`, {
        headers: authorization,
      });
      const removalReader = removalEvents.body!.getReader();
      const removalFrame = yield* Effect.tryPromise(() => removalReader.read());
      assert.include(new TextDecoder().decode(removalFrame.value), '"kind":"peer.deleted"');
      yield* Effect.promise(() => removalReader.cancel());
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
