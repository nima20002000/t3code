import * as NodeServices from "@effect/platform-node/NodeServices";
import { createWorkflow } from "@t3tools/board-core";
import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardStore from "./BoardStore.ts";
import * as PeerStore from "./remote/PeerStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

it.effect("keeps core and board migration histories and board data across reopening", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "board-migrations-" });
      const layer = BoardStore.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"))),
      );
      const peer = {
        id: "remote",
        name: "Remote",
        environmentId: EnvironmentId.make("remote"),
        url: "https://remote.example.test/",
        bearer: "private-board-bearer",
      };
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* BoardStore.BoardStore;
          const core = yield* sql<{
            readonly migration_id: number;
            readonly name: string;
          }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
          yield* store.transaction(
            Effect.gen(function* () {
              const workflow = createWorkflow("workflow", "Workflow", "workspace");
              yield* store.putWorkflow(workflow);
              yield* store.appendEvent({ kind: "workflow.upserted", workflow });
            }),
          );
          yield* PeerStore.makeBoard(store).put(peer);
          return core;
        }).pipe(Effect.provide(layer)),
      );
      assert.isTrue(first.length > 0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* BoardStore.BoardStore;
          const core = yield* sql<{
            readonly migration_id: number;
            readonly name: string;
          }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
          const board = yield* sql<{
            readonly migration_id: number;
            readonly name: string;
          }>`SELECT migration_id, name FROM board_migrations ORDER BY migration_id`;
          assert.deepStrictEqual(core, first);
          assert.deepStrictEqual(board, [
            { migration_id: 1, name: "Board" },
            { migration_id: 2, name: "BoardIntents" },
            { migration_id: 3, name: "BoardWorkspaces" },
            { migration_id: 4, name: "BoardTaskCards" },
          ]);
          const snapshot = yield* store.snapshot();
          assert.strictEqual(snapshot.sequence, 2);
          assert.strictEqual(snapshot.workflows[0]?.id, "workflow");
          assert.deepStrictEqual(yield* PeerStore.makeBoard(store).get(peer.environmentId), peer);
          assert.strictEqual(snapshot.peers[0]?.environmentId, peer.environmentId);
          assert.notInclude(JSON.stringify(snapshot), peer.bearer);
          const events = yield* store.events(0).pipe(Stream.take(2), Stream.runCollect);
          assert.strictEqual(events[1]?.kind, "peer.upserted");
          assert.notInclude(JSON.stringify(events), peer.bearer);
          const registry = DriverRegistry.layer.pipe(
            Layer.provide(
              Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("hub")),
              }),
            ),
            Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
            Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
            Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          );
          yield* Effect.gen(function* () {
            const drivers = yield* DriverRegistry.DriverRegistry;
            assert.isDefined(yield* drivers.get(peer.environmentId));
            assert.isDefined(yield* drivers.get(EnvironmentId.make("hub")));
          }).pipe(Effect.provide(registry));
          const peers = PeerStore.makeBoard(store);
          yield* peers.setStatus!(peer, "error", "Connection failed.");
          assert.strictEqual((yield* store.snapshot()).peers[0]?.status, "error");
          const replacement = { ...peer, bearer: "replacement-board-bearer" };
          yield* peers.put(replacement);
          yield* peers.setStatus!(peer, "error", "Stale connection failed.");
          const afterRePairing = yield* store.snapshot();
          assert.strictEqual(afterRePairing.sequence, 4);
          assert.strictEqual(afterRePairing.peers[0]?.status, "connected");
          assert.notInclude(JSON.stringify(afterRePairing), replacement.bearer);
          yield* peers.remove(peer.environmentId);
          assert.deepStrictEqual(yield* store.listPeers(), []);
          const deleted = yield* store.events(4).pipe(Stream.take(1), Stream.runCollect);
          assert.strictEqual(deleted[0]?.kind, "peer.deleted");
        }).pipe(Effect.provide(layer)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("rolls board state and its event back together", () =>
  Effect.gen(function* () {
    const store = yield* BoardStore.BoardStore;
    yield* store
      .transaction(
        Effect.gen(function* () {
          const workflow = createWorkflow("rolled-back", "Rolled back", "workspace");
          yield* store.putWorkflow(workflow);
          yield* store.appendEvent({ kind: "workflow.upserted", workflow });
          return yield* Effect.fail("abort");
        }),
      )
      .pipe(Effect.flip);
    assert.strictEqual((yield* store.snapshot()).sequence, 0);
    assert.deepStrictEqual(yield* store.listWorkflows(), []);
  }).pipe(Effect.provide(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("prunes old events and ends replay that would have a gap", () =>
  Effect.gen(function* () {
    const store = yield* BoardStore.BoardStore;
    const workflow = createWorkflow("pruned", "Pruned", "workspace");
    const total = BoardStore.EVENT_RETENTION + 5;
    yield* store.transaction(
      Effect.forEach(
        Array.from({ length: total }),
        () => store.appendEvent({ kind: "workflow.upserted", workflow }),
        { discard: true },
      ),
    );
    const sql = yield* SqlClient.SqlClient;
    const kept = yield* sql<{
      readonly count: number;
      readonly oldest: number;
    }>`SELECT COUNT(*) AS count, MIN(sequence) AS oldest FROM board_task_events`;
    assert.strictEqual(kept[0]?.count, BoardStore.EVENT_RETENTION);
    assert.strictEqual(kept[0]?.oldest, 6);
    assert.deepStrictEqual(Array.from(yield* Stream.runCollect(store.events(0))), []);
    const resumed = yield* store.events(5).pipe(Stream.take(1), Stream.runCollect);
    assert.strictEqual(resumed[0]?.sequence, 6);
  }).pipe(Effect.provide(BoardStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))),
);
