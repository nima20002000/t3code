import type { BoardEvent, BoardPeer, BoardSchedule, Workflow } from "@t3tools/board-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completing"
  | "done"
  | "failed"
  | "stopped";

export interface BoardTask {
  readonly id: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly kind: "run" | "request";
  readonly owner: string | null;
  readonly nodeId: string;
  readonly status: TaskStatus;
  readonly checkpoint: unknown;
  readonly waitOn: ReadonlyArray<string>;
  readonly waitPolicy: "allSettled" | "failFast";
}

type EventInput = BoardEvent extends infer E
  ? E extends BoardEvent
    ? Omit<E, "sequence">
    : never
  : never;
type StoreEffect<A> = Effect.Effect<A, SqlError>;

export class BoardStore extends Context.Service<
  BoardStore,
  {
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SqlError, R>;
    readonly getWorkflow: (id: string) => StoreEffect<Workflow | undefined>;
    readonly listWorkflows: () => StoreEffect<ReadonlyArray<Workflow>>;
    readonly putWorkflow: (workflow: Workflow) => StoreEffect<void>;
    readonly deleteWorkflow: (id: string) => StoreEffect<void>;
    readonly getTask: (id: string) => StoreEffect<BoardTask | undefined>;
    readonly listTasks: (runId?: string) => StoreEffect<ReadonlyArray<BoardTask>>;
    readonly putTask: (task: BoardTask) => StoreEffect<void>;
    readonly listPeers: () => StoreEffect<ReadonlyArray<BoardPeer>>;
    readonly listSchedules: () => StoreEffect<ReadonlyArray<BoardSchedule>>;
    readonly putSchedule: (schedule: BoardSchedule) => StoreEffect<void>;
    readonly deleteSchedule: (id: string) => StoreEffect<void>;
    readonly appendEvent: (event: EventInput) => StoreEffect<void>;
    readonly snapshot: () => StoreEffect<{
      readonly sequence: number;
      readonly workflows: ReadonlyArray<Workflow>;
      readonly peers: ReadonlyArray<BoardPeer>;
      readonly schedules: ReadonlyArray<BoardSchedule>;
    }>;
    readonly events: (afterSequence: number) => Stream.Stream<BoardEvent, SqlError>;
  }
>()("t3/board/BoardStore") {}

const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE board_workflows (id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
  yield* sql`CREATE TABLE board_nodes (workflow_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (workflow_id, id), FOREIGN KEY (workflow_id) REFERENCES board_workflows(id) ON DELETE CASCADE)`;
  yield* sql`CREATE TABLE board_edges (workflow_id TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (workflow_id, source, target), FOREIGN KEY (workflow_id) REFERENCES board_workflows(id) ON DELETE CASCADE)`;
  yield* sql`CREATE TABLE board_peers (id TEXT PRIMARY KEY, data TEXT NOT NULL, bearer TEXT NOT NULL)`;
  yield* sql`CREATE TABLE board_tasks (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT, node_id TEXT NOT NULL, status TEXT NOT NULL, checkpoint TEXT NOT NULL, wait_on TEXT NOT NULL, wait_policy TEXT NOT NULL)`;
  yield* sql`CREATE INDEX board_tasks_run ON board_tasks(run_id)`;
  yield* sql`CREATE TABLE board_task_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)`;
  yield* sql`CREATE TABLE board_schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
});

export const migrate = Migrator.make({})({
  table: "board_migrations",
  loader: Migrator.fromRecord({ "1_Board": migration }),
});

type JsonRow = { readonly data: string };
const json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(json);
const decodeJson = Schema.decodeUnknownSync(json);
type TaskRow = {
  readonly id: string;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly kind: BoardTask["kind"];
  readonly owner: string | null;
  readonly node_id: string;
  readonly status: TaskStatus;
  readonly checkpoint: string;
  readonly wait_on: string;
  readonly wait_policy: BoardTask["waitPolicy"];
};

const taskFromRow = (row: TaskRow): BoardTask => ({
  id: row.id,
  workflowId: row.workflow_id,
  runId: row.run_id,
  kind: row.kind,
  owner: row.owner,
  nodeId: row.node_id,
  status: row.status,
  checkpoint: decodeJson(row.checkpoint),
  waitOn: decodeJson(row.wait_on) as ReadonlyArray<string>,
  waitPolicy: row.wait_policy,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* migrate;
  const changes = yield* PubSub.sliding<void>(1);

  const transaction: BoardStore["Service"]["transaction"] = (effect) =>
    sql.withTransaction(effect).pipe(Effect.tap(() => PubSub.publish(changes, undefined)));
  const getWorkflow = Effect.fn("BoardStore.getWorkflow")(function* (id: string) {
    const rows = yield* sql<JsonRow>`SELECT data FROM board_workflows WHERE id = ${id}`;
    return rows[0] === undefined ? undefined : (decodeJson(rows[0].data) as Workflow);
  });
  const listWorkflows = Effect.fn("BoardStore.listWorkflows")(function* () {
    const rows = yield* sql<JsonRow>`SELECT data FROM board_workflows ORDER BY rowid`;
    return rows.map((row) => decodeJson(row.data) as Workflow);
  });
  const putWorkflow = Effect.fn("BoardStore.putWorkflow")(function* (workflow: Workflow) {
    yield* sql`INSERT INTO board_workflows (id, data) VALUES (${workflow.id}, ${encodeJson(workflow)}) ON CONFLICT(id) DO UPDATE SET data = excluded.data`;
    yield* sql`DELETE FROM board_nodes WHERE workflow_id = ${workflow.id}`;
    yield* sql`DELETE FROM board_edges WHERE workflow_id = ${workflow.id}`;
    for (const node of workflow.nodes) {
      yield* sql`INSERT INTO board_nodes (workflow_id, id, data) VALUES (${workflow.id}, ${node.id}, ${encodeJson(node)})`;
    }
    for (const edge of workflow.edges) {
      yield* sql`INSERT INTO board_edges (workflow_id, source, target) VALUES (${workflow.id}, ${edge.a}, ${edge.b})`;
    }
  });
  const deleteWorkflow = Effect.fn("BoardStore.deleteWorkflow")(function* (id: string) {
    yield* sql`DELETE FROM board_workflows WHERE id = ${id}`;
  });
  const getTask = Effect.fn("BoardStore.getTask")(function* (id: string) {
    const rows = yield* sql<TaskRow>`SELECT * FROM board_tasks WHERE id = ${id}`;
    return rows[0] === undefined ? undefined : taskFromRow(rows[0]);
  });
  const listTasks = Effect.fn("BoardStore.listTasks")(function* (runId?: string) {
    const rows =
      runId === undefined
        ? yield* sql<TaskRow>`SELECT * FROM board_tasks ORDER BY rowid`
        : yield* sql<TaskRow>`SELECT * FROM board_tasks WHERE run_id = ${runId} ORDER BY rowid`;
    return rows.map(taskFromRow);
  });
  const putTask = Effect.fn("BoardStore.putTask")(function* (task: BoardTask) {
    yield* sql`INSERT INTO board_tasks (id, workflow_id, run_id, kind, owner, node_id, status, checkpoint, wait_on, wait_policy)
      VALUES (${task.id}, ${task.workflowId}, ${task.runId}, ${task.kind}, ${task.owner}, ${task.nodeId}, ${task.status}, ${encodeJson(task.checkpoint)}, ${encodeJson(task.waitOn)}, ${task.waitPolicy})
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, checkpoint = excluded.checkpoint, wait_on = excluded.wait_on, wait_policy = excluded.wait_policy`;
  });
  const listPeers = Effect.fn("BoardStore.listPeers")(function* () {
    const rows = yield* sql<JsonRow>`SELECT data FROM board_peers ORDER BY rowid`;
    return rows.map((row) => decodeJson(row.data) as BoardPeer);
  });
  const listSchedules = Effect.fn("BoardStore.listSchedules")(function* () {
    const rows = yield* sql<JsonRow>`SELECT data FROM board_schedules ORDER BY rowid`;
    return rows.map((row) => decodeJson(row.data) as BoardSchedule);
  });
  const putSchedule = Effect.fn("BoardStore.putSchedule")(function* (schedule: BoardSchedule) {
    yield* sql`INSERT INTO board_schedules (id, data) VALUES (${schedule.id}, ${encodeJson(schedule)}) ON CONFLICT(id) DO UPDATE SET data = excluded.data`;
  });
  const deleteSchedule = Effect.fn("BoardStore.deleteSchedule")(function* (id: string) {
    yield* sql`DELETE FROM board_schedules WHERE id = ${id}`;
  });
  const appendEvent = Effect.fn("BoardStore.appendEvent")(function* (event: EventInput) {
    yield* sql`INSERT INTO board_task_events (data) VALUES (${encodeJson(event)})`;
  });
  const snapshot = Effect.fn("BoardStore.snapshot")(function* () {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly sequence: number;
        }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM board_task_events`;
        return {
          sequence: rows[0]?.sequence ?? 0,
          workflows: yield* listWorkflows(),
          peers: yield* listPeers(),
          schedules: yield* listSchedules(),
        };
      }),
    );
  });
  const events = (afterSequence: number) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const cursor = yield* Ref.make(afterSequence);
        const read = Effect.gen(function* () {
          const after = yield* Ref.get(cursor);
          const rows = yield* sql<{
            readonly sequence: number;
            readonly data: string;
          }>`SELECT sequence, data FROM board_task_events WHERE sequence > ${after} ORDER BY sequence`;
          if (rows.length > 0) yield* Ref.set(cursor, rows[rows.length - 1]!.sequence);
          return rows.map((row) => ({
            ...(decodeJson(row.data) as BoardEvent),
            sequence: row.sequence,
          }));
        });
        const expand = Stream.flatMap((rows: ReadonlyArray<BoardEvent>) =>
          Stream.fromIterable(rows),
        );
        return Stream.concat(
          Stream.fromEffect(read).pipe(expand),
          Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect(() => read),
            expand,
          ),
        );
      }),
    );
  return BoardStore.of({
    transaction,
    getWorkflow,
    listWorkflows,
    putWorkflow,
    deleteWorkflow,
    getTask,
    listTasks,
    putTask,
    listPeers,
    listSchedules,
    putSchedule,
    deleteSchedule,
    appendEvent,
    snapshot,
    events,
  });
});

export const layer = Layer.effect(BoardStore, make);
