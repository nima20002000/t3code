import { assert, it } from "@effect/vitest";
import type { Workflow } from "@t3tools/board-core";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardStore from "./BoardStore.ts";
import { DEFAULT_WORKSPACE_ID, type LegacyWorkflow } from "./legacyMigration.ts";

const hub = EnvironmentId.make("hub");
const italy = EnvironmentId.make("italy");
const legacyNode = (
  id: string,
  patch: { environmentId?: EnvironmentId; projectId?: string; role?: string } = {},
) => ({
  id,
  name: id,
  environmentId: hub,
  threadId: `thread-${id}`,
  x: 1,
  y: 2,
  baselined: true,
  ...patch,
});
const legacyRun = (id: string, nodeId: string, status: string, startedAt: string) => ({
  id,
  nodeId,
  nodeName: nodeId,
  task: "task",
  status,
  startedAt,
  requests: [
    {
      id: `${id}:r`,
      fromId: nodeId,
      toId: "b",
      from: nodeId,
      to: "b",
      at: startedAt,
      task: "t",
      status: "pending",
    },
  ],
});
const legacyWorkflow = (id: string, patch: Record<string, unknown>) => ({
  id,
  name: id,
  nodes: [],
  edges: [],
  pending: [{ id: "p", from: "a", to: "b" }],
  log: [{ id: "l", at: "t", kind: "info", text: "x" }],
  runQueue: [{ id: "q", nodeId: "a", task: "t" }],
  runs: [],
  settings: {
    defaultInstanceId: "claudeAgent",
    defaultModel: "claude-opus",
    runtimeMode: "full-access",
    maxHandoffsPerEdge: null,
  },
  ...patch,
});

const migrateBeforeThree = Migrator.make({})({
  table: "board_migrations",
  loader: Migrator.fromRecord({
    "1_Board": BoardStore.migrations["1_Board"],
    "2_BoardIntents": BoardStore.migrations["2_BoardIntents"],
  }),
});

const insertLegacy = Effect.fn("insertLegacy")(function* (workflow: LegacyWorkflow | object) {
  const sql = yield* SqlClient.SqlClient;
  const row = workflow as LegacyWorkflow;
  yield* sql`INSERT INTO board_workflows (id, data) VALUES (${row.id}, ${JSON.stringify(workflow)})`;
  for (const node of row.nodes)
    yield* sql`INSERT INTO board_nodes (workflow_id, id, data) VALUES (${row.id}, ${node.id}, ${JSON.stringify(node)})`;
});

it.effect("migrates an empty board without inventing a workspace", () =>
  Effect.gen(function* () {
    yield* migrateBeforeThree;
    const store = yield* BoardStore.BoardStore.pipe(Effect.provide(BoardStore.layer));
    const snapshot = yield* store.snapshot();
    assert.deepStrictEqual(snapshot.workspaces, []);
    assert.deepStrictEqual(snapshot.workflows, []);
    assert.deepStrictEqual(snapshot.kanban, []);
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'board_%' ORDER BY name`;
    assert.include(
      tables.map((table) => table.name),
      "board_kanban_cards",
    );
    assert.notInclude(
      tables.map((table) => table.name),
      "board_pending_briefings",
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("moves today's workflows into one default workspace of profile nodes", () =>
  Effect.gen(function* () {
    yield* migrateBeforeThree;
    yield* insertLegacy(
      legacyWorkflow("w1", {
        nodes: [
          legacyNode("a", { projectId: "hub-project" }),
          legacyNode("b", { projectId: "hub-project", role: " Review code " }),
          legacyNode("c", { environmentId: italy, projectId: "italy-project" }),
        ],
        edges: [
          { a: "a", b: "b" },
          { a: "a", b: "c" },
        ],
        runs: [
          legacyRun("old", "a", "finished", "2026-01-01T00:00:00.000Z"),
          legacyRun("live", "a", "running", "2026-01-02T00:00:00.000Z"),
        ],
      }),
    );
    // Entry is not the node with outgoing edges here, so the first node that hands out work leads.
    yield* insertLegacy(
      legacyWorkflow("w2", {
        nodes: [legacyNode("x"), legacyNode("y", { projectId: "other-project" })],
        edges: [{ a: "y", b: "x" }],
        runs: [legacyRun("r", "x", "finished", "2026-01-03T00:00:00.000Z")],
      }),
    );
    yield* insertLegacy(legacyWorkflow("w3", { nodes: [legacyNode("solo")] }));
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO board_launch_intents (workflow_id, node_id, thread_id) VALUES ('w1', 'a', 't')`;
    const task = (id: string, status: string) =>
      sql`INSERT INTO board_tasks (id, workflow_id, run_id, kind, owner, node_id, status, checkpoint, wait_on, wait_policy) VALUES (${id}, 'w1', 'live', 'run', NULL, 'a', ${status}, '{}', '[]', 'allSettled')`;
    yield* task("t-waiting", "waiting");
    yield* task("t-done", "done");
    yield* task("t-completing", "completing");
    yield* sql`INSERT INTO board_task_events (data) VALUES ('{"kind":"workflow.upserted","workflow":{"legacy":true}}')`;

    const store = yield* BoardStore.BoardStore.pipe(Effect.provide(BoardStore.layer));
    const snapshot = yield* store.snapshot();

    assert.deepStrictEqual(snapshot.workspaces, [
      {
        id: DEFAULT_WORKSPACE_ID,
        name: "Default workspace",
        folders: [
          {
            environmentId: hub,
            projectId: ProjectId.make("hub-project"),
            path: "",
            managed: false,
          },
          {
            environmentId: italy,
            projectId: ProjectId.make("italy-project"),
            path: "",
            managed: false,
          },
        ],
      },
    ]);
    const byId = new Map(snapshot.workflows.map((workflow) => [workflow.id, workflow]));
    const profiles = (workflow: Workflow | undefined) =>
      Object.fromEntries((workflow?.nodes ?? []).map((node) => [node.id, node.profile]));
    assert.deepStrictEqual(profiles(byId.get("w1")), {
      a: "orchestrator",
      b: "worker",
      c: "worker",
    });
    assert.deepStrictEqual(profiles(byId.get("w2")), { x: "worker", y: "orchestrator" });
    assert.deepStrictEqual(profiles(byId.get("w3")), { solo: "orchestrator" });
    const w1 = byId.get("w1")!;
    assert.strictEqual(w1.workspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepStrictEqual(w1.nodes[1], {
      id: "b",
      name: "b",
      profile: "worker",
      environmentId: hub,
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" },
      prompt: " Review code ",
      x: 1,
      y: 2,
    });
    assert.deepStrictEqual(w1.pending, []);
    assert.deepStrictEqual(w1.runQueue, []);
    assert.strictEqual(w1.log.length, 1);
    assert.deepStrictEqual(
      w1.runs.map((run) => [run.id, run.status, run.requests[0]?.status]),
      [
        ["old", "finished", "pending"],
        ["live", "stopped", "stopped"],
      ],
    );
    assert.deepStrictEqual(w1.runs[0]?.threads, {});
    assert.deepStrictEqual(
      w1.runs[0]?.definition.nodes.map((node) => node.profile),
      ["orchestrator", "worker", "worker"],
    );

    const tasks = yield* store.listTasks();
    assert.deepStrictEqual(
      tasks.map((entry) => [entry.id, entry.status]),
      [
        ["t-waiting", "stopped"],
        ["t-done", "done"],
        ["t-completing", "completing"],
      ],
    );
    const tables = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE name = 'board_launch_intents'`;
    assert.deepStrictEqual(tables, []);
    const rows = yield* sql<{
      readonly workspace_id: string;
    }>`SELECT workspace_id FROM board_workflows`;
    assert.deepStrictEqual(
      rows.map((row) => row.workspace_id),
      Array(3).fill(DEFAULT_WORKSPACE_ID),
    );
    // Old events carry the old shape: only the migrated state is replayed.
    assert.deepStrictEqual(Array.from(yield* Stream.runCollect(store.events(0))), []);
    const events = yield* store.events(1).pipe(Stream.take(4), Stream.runCollect);
    assert.deepStrictEqual(
      events.map((event) => event.kind),
      ["workspace.upserted", "workflow.upserted", "workflow.upserted", "workflow.upserted"],
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
