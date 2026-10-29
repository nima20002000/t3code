import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardStore from "./BoardStore.ts";

const migrateBeforeTiming = Migrator.make({})({
  table: "board_migrations",
  loader: Migrator.fromRecord({
    "1_Board": BoardStore.migrations["1_Board"],
    "2_BoardIntents": BoardStore.migrations["2_BoardIntents"],
    "3_BoardWorkspaces": BoardStore.migrations["3_BoardWorkspaces"],
    "4_BoardTaskCards": BoardStore.migrations["4_BoardTaskCards"],
  }),
});

it.effect("an every-N-minutes workflow schedule keeps its interval and due run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrateBeforeTiming;
    const old = {
      id: "s",
      workflowId: "w",
      task: "Work",
      everyMs: 300_000,
      enabled: true,
      nextRunAt: "2026-01-01T00:05:00.000Z",
    };
    yield* sql`INSERT INTO board_schedules (id, data) VALUES ('s', ${JSON.stringify(old)})`;
    yield* sql`INSERT INTO board_schedules (id, data) VALUES ('fast', ${JSON.stringify({ ...old, id: "fast", everyMs: 30_000 })})`;
    yield* sql`INSERT INTO board_task_events (data) VALUES (${JSON.stringify({ kind: "schedule.upserted", schedule: old })})`;
    yield* BoardStore.migrate;
    const expected = {
      id: "s",
      workflowId: "w",
      task: "Work",
      timing: { type: "interval" as const, everyMs: 300_000 },
      runCount: 0,
      enabled: true,
      nextRunAt: "2026-01-01T00:05:00.000Z",
    };
    yield* Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      assert.deepStrictEqual(yield* store.listSchedules(), [
        expected,
        { ...expected, id: "fast", timing: { type: "interval", everyMs: 60_000 } },
      ]);
      const [event] = yield* store.events(0).pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(event, { kind: "schedule.upserted", sequence: 1, schedule: expected });
    }).pipe(Effect.provide(BoardStore.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
