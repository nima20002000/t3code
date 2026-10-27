import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { FetchHttpClient } from "effect/http";
import * as PeerStore from "./PeerStore.ts";
import * as RemoteDriver from "./RemoteDriver.ts";

it.effect("does not send a bearer to an address now identifying a different environment", () =>
  Effect.gen(function* () {
    const peer = {
      id: "expected",
      name: "Remote",
      environmentId: EnvironmentId.make("expected"),
      url: "https://peer.test/",
      bearer: "test-secret",
    };
    const store = PeerStore.makeMemory();
    yield* store.put(peer);
    const paths: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      paths.push(new URL(String(input)).pathname);
      return Promise.resolve(
        Response.json({
          environmentId: "different",
          label: "Other",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1.0",
          orchestrationProtocolVersion: 2,
          capabilities: {},
        }),
      );
    };
    const result = yield* RemoteDriver.make(store)
      .launch({
        environmentId: peer.environmentId,
        launch: {
          commandId: CommandId.make("launch"),
          projectId: ProjectId.make("project"),
          threadId: ThreadId.make("thread"),
          title: "Node",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        },
      })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.equal(result.failure.operation, "launch");
    assert.deepEqual(paths, ["/.well-known/t3/environment"]);
  }),
);

it.live("reconnects after a transient descriptor failure and surfaces rejected credentials", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("remote");
    const store = PeerStore.makeMemory();
    yield* store.put({
      id: "remote",
      name: "Remote",
      environmentId,
      url: "https://peer.test/",
      bearer: "test-secret",
    });
    const paths: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (paths.length === 1) return Promise.resolve(new Response(null, { status: 503 }));
      if (path === "/api/auth/websocket-ticket/rpc")
        return Promise.resolve(new Response(null, { status: 401 }));
      return Promise.resolve(
        Response.json({
          environmentId,
          label: "Remote",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1.0",
          orchestrationProtocolVersion: 2,
          capabilities: {},
        }),
      );
    };
    const result = yield* RemoteDriver.make(store)
      .launch({
        environmentId,
        launch: {
          commandId: CommandId.make("retry-launch"),
          projectId: ProjectId.make("project"),
          threadId: ThreadId.make("thread"),
          title: "Node",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        },
      })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.deepEqual(paths, [
      "/.well-known/t3/environment",
      "/.well-known/t3/environment",
      "/api/auth/websocket-ticket/rpc",
    ]);
  }),
);

it.effect("fails with a re-pair error and sends nothing once the paired bearer expired", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("expired");
    const store = PeerStore.makeMemory();
    yield* store.put({
      id: "expired",
      name: "Remote",
      environmentId,
      url: "https://peer.test/",
      bearer: "test-secret",
      expiresAt: "1969-12-31T00:00:00.000Z",
    });
    const paths: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      paths.push(new URL(String(input)).pathname);
      return Promise.resolve(new Response(null, { status: 500 }));
    };
    const result = yield* RemoteDriver.make(store)
      .interrupt({
        thread: {
          environmentId,
          projectId: ProjectId.make("project"),
          threadId: ThreadId.make("thread"),
        },
        commandId: CommandId.make("interrupt"),
      })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.include(result.failure.message, "Re-pair needed");
      assert.isUndefined(result.failure.retryable);
    }
    assert.deepEqual(paths, []);
  }),
);
