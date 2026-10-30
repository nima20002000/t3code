import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ForkReleaseEntry } from "@t3tools/board-core";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerSelfUpdateOutcome,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  AutoUpdateError,
  layer as autoUpdateLayer,
  listForkReleases,
  runAutoUpdate,
  serverBusyReason,
} from "./AutoUpdate.ts";
import * as BoardStore from "./BoardStore.ts";

const fork = (version: string): ForkReleaseEntry => ({ tag_name: `v${version}` });

/** A server on `currentVersion` whose release list, busy state and updates the test controls. */
const server = Effect.fn(function* (
  currentVersion: string,
  initial: {
    readonly releases: ReadonlyArray<ForkReleaseEntry>;
    readonly busy?: string | null;
    readonly failUpdates?: boolean;
    readonly previousUpdate?: ServerSelfUpdateOutcome;
  },
) {
  const releases = yield* Ref.make(initial.releases);
  const busy = yield* Ref.make(initial.busy ?? null);
  const updates = yield* Ref.make<ReadonlyArray<string>>([]);
  const handoffs = yield* Ref.make<ReadonlyArray<string>>([]);
  // Work that starts while the release downloads, before the restart.
  const startsWhileStaging = yield* Ref.make<string | null>(null);
  const fiber = yield* runAutoUpdate({
    currentVersion,
    previousUpdate: Effect.succeed(initial.previousUpdate),
    releases: Ref.get(releases),
    busy: Ref.get(busy),
    update: (targetVersion, beforeHandoff) =>
      Effect.gen(function* () {
        yield* Ref.update(updates, (all) => [...all, targetVersion]);
        if (initial.failUpdates === true) return yield* new AutoUpdateError({ step: "update" });
        const started = yield* Ref.getAndSet(startsWhileStaging, null);
        if (started !== null) yield* Ref.set(busy, started);
        yield* beforeHandoff;
        yield* Ref.update(handoffs, (all) => [...all, targetVersion]);
      }),
  }).pipe(Effect.forkChild);
  return {
    releases,
    busy,
    startsWhileStaging,
    updates: Ref.get(updates),
    handoffs: Ref.get(handoffs),
    fiber,
  };
});

it.effect("updates from a release index whose full fork release is on a later page", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make((request) => {
      const page = new URL(request.url).searchParams.get("page");
      const releases =
        page === "1"
          ? Array.from({ length: 100 }, (_, index) => ({
              tag_name: `v0.1.6-board.${index + 1}`,
              prerelease: true,
            }))
          : [fork("0.1.5-board.4")];
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(releases)));
    });
    const releases = yield* listForkReleases(
      "https://api.github.com/repos/nima20002000/t3code/releases",
      Option.none(),
    ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const s = yield* server("0.1.5-board.3", { releases });
    yield* TestClock.adjust("2 minutes");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.4"]);
  }),
);

it.effect("updates to the newest fork release shortly after start when idle", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.3", {
      releases: [fork("0.1.5-board.5"), fork("0.1.5-board.4"), fork("0.1.5-board.3")],
    });
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* s.updates, []);
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.5"]);
    // Handed off: the service restarts on the new version, so this server stops checking.
    yield* Fiber.join(s.fiber);
  }),
);

it.effect("ignores a newer upstream t3 release and keeps checking hourly", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.4", {
      releases: [{ tag_name: "v0.1.9" }, fork("0.1.5-board.4")],
    });
    yield* TestClock.adjust("3 hours");
    assert.deepStrictEqual(yield* s.updates, []);
    yield* Ref.set(s.releases, [{ tag_name: "v0.1.9" }, fork("0.1.6-board.1")]);
    yield* TestClock.adjust("1 hour");
    assert.deepStrictEqual(yield* s.updates, ["0.1.6-board.1"]);
  }),
);

it.effect("never downgrades and never moves a build that is not a fork build", () =>
  Effect.gen(function* () {
    const newer = yield* server("0.1.6-board.2", { releases: [fork("0.1.6-board.1")] });
    const upstreamBuild = yield* server("0.1.5", { releases: [fork("0.1.6-board.1")] });
    yield* TestClock.adjust("5 hours");
    assert.deepStrictEqual(yield* newer.updates, []);
    assert.deepStrictEqual(yield* upstreamBuild.updates, []);
  }),
);

it.effect("waits while a turn runs and updates once the server is idle", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.3", {
      releases: [fork("0.1.5-board.4")],
      busy: "an agent turn is running",
    });
    yield* TestClock.adjust("90 minutes");
    assert.deepStrictEqual(yield* s.updates, []);
    yield* Ref.set(s.busy, "a board run is running");
    yield* TestClock.adjust("10 minutes");
    assert.deepStrictEqual(yield* s.updates, []);
    yield* Ref.set(s.busy, null);
    yield* Ref.set(s.releases, [fork("0.1.5-board.5"), fork("0.1.5-board.4")]);
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.5"]);
  }),
);

it.effect("leaves a rolled-back release alone across restarts but accepts its successor", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.3", {
      releases: [fork("0.1.5-board.4")],
      previousUpdate: {
        id: "bad-release",
        fromVersion: "0.1.5-board.3",
        targetVersion: "0.1.5-board.4",
        status: "rolled-back",
      },
    });
    yield* TestClock.adjust("5 hours");
    assert.deepStrictEqual(yield* s.updates, []);
    yield* Ref.set(s.releases, [fork("0.1.5-board.5"), fork("0.1.5-board.4")]);
    yield* TestClock.adjust("1 hour");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.5"]);
  }),
);

it.effect("a failed update is tried again at the next hourly check", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.3", {
      releases: [fork("0.1.5-board.4")],
      failUpdates: true,
    });
    yield* TestClock.adjust("2 minutes");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.4"]);
    yield* TestClock.adjust("59 minutes");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.4"]);
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.4", "0.1.5-board.4"]);
  }),
);

it.effect("holds the restart when a turn starts while the release is staged", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.3", { releases: [fork("0.1.5-board.4")] });
    yield* Ref.set(s.startsWhileStaging, "an agent turn is running");
    yield* TestClock.adjust("2 minutes");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.4"]);
    assert.deepStrictEqual(yield* s.handoffs, []);
    yield* TestClock.adjust("5 minutes");
    assert.deepStrictEqual(yield* s.handoffs, []);
    yield* Ref.set(s.busy, null);
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* s.handoffs, ["0.1.5-board.4"]);
  }),
);

const busyLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);

it.layer(busyLayer)("what a restart would cut", (it) => {
  it.effect("T3 Code's own idle compaction keeps the server busy until it finishes", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:auto-update-compaction");
      const runId = RunId.make("run:auto-update-compaction");
      const messageId = MessageId.make("message:auto-update-compaction");
      const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "haiku" };
      assert.strictEqual(yield* serverBusyReason(), null);
      yield* projections.apply({
        id: EventId.make("event:auto-update-compaction:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:auto-update"),
          title: "Compacting",
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:auto-update-compaction:message"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "server",
          id: messageId,
          threadId,
          runId,
          nodeId: null,
          role: "user",
          text: "/compact",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* projections.apply({
        id: EventId.make("event:auto-update-compaction:run"),
        type: "run.created",
        threadId,
        runId,
        nodeId: NodeId.make("node:auto-update-compaction"),
        driver: ProviderDriverKind.make("claudeAgent"),
        occurredAt: now,
        payload: run,
      });
      assert.strictEqual(yield* serverBusyReason(), "an agent turn is running");

      yield* projections.apply({
        id: EventId.make("event:auto-update-compaction:done"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: NodeId.make("node:auto-update-compaction"),
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      assert.strictEqual(yield* serverBusyReason(), null);
    }),
  );
});

/**
 * Starts the auto-update layer with only what t3 gives the board's routes: a launcher, t3's
 * self-update, an HTTP client, SQL and the board store. t3 hands its projection store to each of
 * its own services privately, so it is deliberately absent here. Returns what the layer logged.
 */
const startAutoUpdate = Effect.fn(function* (managed: boolean) {
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => {
    messages.push(String(message));
  });
  const baseDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  const routesContext = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), baseDir),
    Layer.succeed(
      ServiceLauncherClient.ServiceLauncherClient,
      ServiceLauncherClient.ServiceLauncherClient.of({
        managed,
        requestUpdate: () => Effect.succeed("launcher-id"),
        prepareTrial: Effect.undefined,
      }),
    ),
    Layer.succeed(
      ServerSelfUpdate.ServerSelfUpdate,
      ServerSelfUpdate.ServerSelfUpdate.of({
        update: () => Effect.die("no update in this test"),
        commitDesktopUpdate: () => Effect.die("no update in this test"),
      }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json([]))),
      ),
    ),
    BoardStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    Logger.layer([logger], { mergeWithExisting: false }),
  );
  yield* Layer.build(autoUpdateLayer.pipe(Layer.provide(routesContext)));
  return messages;
});

it.effect("a service-managed server starts following the fork's releases at startup", () =>
  Effect.gen(function* () {
    const messages = yield* startAutoUpdate(true);
    assert.isTrue(
      messages.some((message) => message.includes("follows the fork's releases")),
      messages.join("\n"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a server that will not update itself says why in its log", () =>
  Effect.gen(function* () {
    const messages = yield* startAutoUpdate(false);
    assert.isTrue(
      messages.some((message) =>
        message.includes(
          "Board auto-update is off: this server is not run by the t3 service launcher",
        ),
      ),
      messages.join("\n"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
