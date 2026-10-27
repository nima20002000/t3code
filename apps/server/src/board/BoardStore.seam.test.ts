import * as NodeServices from "@effect/platform-node/NodeServices";
import { createWorkflow } from "@t3tools/board-core";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardStore from "./BoardStore.ts";

it.effect("keeps core and board migration histories and board data across reopening", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "board-migrations-" });
      const layer = BoardStore.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"))),
      );
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
              const workflow = createWorkflow("workflow", "Workflow");
              yield* store.putWorkflow(workflow);
              yield* store.appendEvent({ kind: "workflow.upserted", workflow });
            }),
          );
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
          assert.deepStrictEqual(board, [{ migration_id: 1, name: "Board" }]);
          const snapshot = yield* store.snapshot();
          assert.strictEqual(snapshot.sequence, 1);
          assert.strictEqual(snapshot.workflows[0]?.id, "workflow");
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
          const workflow = createWorkflow("rolled-back", "Rolled back");
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
