import type {
  BoardEvent,
  BoardPeer,
  BoardSchedule,
  KanbanCard,
  Workflow,
  Workspace,
} from "@t3tools/board-core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { upgradeLegacyBoard, type LegacyWorkflow } from "./legacyMigration.ts";
import type { Peer } from "./remote/PeerStore.ts";

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

export const EVENT_RETENTION = 10_000;

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
    readonly listWorkspaces: () => StoreEffect<ReadonlyArray<Workspace>>;
    readonly getWorkspace: (id: string) => StoreEffect<Workspace | undefined>;
    readonly putWorkspace: (workspace: Workspace) => StoreEffect<void>;
    readonly deleteWorkspace: (id: string) => StoreEffect<void>;
    readonly listKanban: (workflowId: string) => StoreEffect<ReadonlyArray<KanbanCard>>;
    readonly putCard: (workflowId: string, card: KanbanCard) => StoreEffect<void>;
    readonly deleteCard: (workflowId: string, cardId: string) => StoreEffect<void>;
    readonly getWorkflow: (id: string) => StoreEffect<Workflow | undefined>;
    readonly listWorkflows: () => StoreEffect<ReadonlyArray<Workflow>>;
    readonly putWorkflow: (workflow: Workflow) => StoreEffect<void>;
    readonly deleteWorkflow: (id: string) => StoreEffect<void>;
    readonly getTask: (id: string) => StoreEffect<BoardTask | undefined>;
    readonly listTasks: (runId?: string) => StoreEffect<ReadonlyArray<BoardTask>>;
    readonly putTask: (task: BoardTask) => StoreEffect<void>;
    readonly deleteRunTasks: (runIds: ReadonlyArray<string>) => StoreEffect<void>;
    readonly listPeers: () => StoreEffect<ReadonlyArray<BoardPeer>>;
    readonly getPeer: (id: EnvironmentId) => StoreEffect<Peer | undefined>;
    readonly listPairedPeers: () => StoreEffect<ReadonlyArray<Peer>>;
    readonly putPeer: (peer: Peer) => StoreEffect<BoardPeer>;
    readonly deletePeer: (id: EnvironmentId) => StoreEffect<void>;
    readonly updatePeerStatus: (
      peer: Peer,
      status: BoardPeer["status"],
      error?: string,
    ) => StoreEffect<BoardPeer | undefined>;
    readonly listSchedules: () => StoreEffect<ReadonlyArray<BoardSchedule>>;
    readonly putSchedule: (schedule: BoardSchedule) => StoreEffect<void>;
    readonly deleteSchedule: (id: string) => StoreEffect<void>;
    readonly appendEvent: (event: EventInput) => StoreEffect<number>;
    readonly snapshot: () => StoreEffect<{
      readonly sequence: number;
      readonly workspaces: ReadonlyArray<Workspace>;
      readonly workflows: ReadonlyArray<Workflow>;
      readonly kanban: ReadonlyArray<{
        readonly workflowId: string;
        readonly cards: ReadonlyArray<KanbanCard>;
      }>;
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

const intentsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE board_launch_intents (workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY (workflow_id, node_id), FOREIGN KEY (workflow_id) REFERENCES board_workflows(id) ON DELETE CASCADE)`;
  yield* sql`CREATE TABLE board_pending_briefings (workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY (workflow_id, node_id), FOREIGN KEY (workflow_id) REFERENCES board_workflows(id) ON DELETE CASCADE)`;
});

const workspacesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE board_workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL)`;
  yield* sql`CREATE TABLE board_workspace_folders (workspace_id TEXT NOT NULL, environment_id TEXT NOT NULL, project_id TEXT NOT NULL, path TEXT NOT NULL, managed INTEGER NOT NULL, PRIMARY KEY (workspace_id, environment_id), FOREIGN KEY (workspace_id) REFERENCES board_workspaces(id) ON DELETE CASCADE)`;
  yield* sql`CREATE TABLE board_kanban_cards (workflow_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (workflow_id, id), FOREIGN KEY (workflow_id) REFERENCES board_workflows(id) ON DELETE CASCADE)`;
  yield* sql`ALTER TABLE board_workflows ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`;
  // Threads are per run now, so the fixed-thread launch and briefing bookkeeping has no use.
  yield* sql`DROP TABLE board_launch_intents`;
  yield* sql`DROP TABLE board_pending_briefings`;
  const rows = yield* sql<
    JsonRow & { readonly id: string }
  >`SELECT id, data FROM board_workflows ORDER BY rowid`;
  if (rows.length === 0) return;
  const endedAt = DateTime.formatIso(yield* DateTime.now);
  const { workspace, workflows } = upgradeLegacyBoard(
    rows.map((row) => decodeJson(row.data) as LegacyWorkflow),
    endedAt,
  );
  yield* sql`INSERT INTO board_workspaces (id, name) VALUES (${workspace.id}, ${workspace.name})`;
  for (const folder of workspace.folders)
    yield* sql`INSERT INTO board_workspace_folders (workspace_id, environment_id, project_id, path, managed) VALUES (${workspace.id}, ${folder.environmentId}, ${folder.projectId}, ${folder.path}, ${folder.managed ? 1 : 0})`;
  for (const workflow of workflows) {
    yield* sql`UPDATE board_workflows SET data = ${encodeJson(workflow)}, workspace_id = ${workspace.id} WHERE id = ${workflow.id}`;
    yield* sql`DELETE FROM board_nodes WHERE workflow_id = ${workflow.id}`;
    for (const node of workflow.nodes)
      yield* sql`INSERT INTO board_nodes (workflow_id, id, data) VALUES (${workflow.id}, ${node.id}, ${encodeJson(node)})`;
  }
  // Work that was waiting on a fixed thread cannot continue; tasks being interrupted still finish.
  yield* sql`UPDATE board_tasks SET status = 'stopped' WHERE status IN ('pending', 'running', 'waiting')`;
  // Old events carry the old workflow shape. Clients that last saw them resync from a snapshot.
  yield* sql`DELETE FROM board_task_events`;
  for (const event of [
    { kind: "workspace.upserted", workspace },
    ...workflows.map((entry) => ({ kind: "workflow.upserted", workflow: entry })),
  ])
    yield* sql`INSERT INTO board_task_events (data) VALUES (${encodeJson(event)})`;
});

export const migrations = {
  "1_Board": migration,
  "2_BoardIntents": intentsMigration,
  "3_BoardWorkspaces": workspacesMigration,
};

export const migrate = Migrator.make({})({
  table: "board_migrations",
  loader: Migrator.fromRecord(migrations),
});

type JsonRow = { readonly data: string };
type PeerRow = JsonRow & { readonly bearer: string };
const json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(json);
const decodeJson = Schema.decodeUnknownSync(json);
const peerFromRow = (row: PeerRow): Peer => {
  const peer = decodeJson(row.data) as BoardPeer;
  return {
    id: peer.id,
    name: peer.name,
    environmentId: peer.environmentId,
    url: peer.url,
    bearer: row.bearer,
    ...(peer.expiresAt ? { expiresAt: peer.expiresAt } : {}),
  };
};
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
    yield* sql`INSERT INTO board_workflows (id, data, workspace_id) VALUES (${workflow.id}, ${encodeJson(workflow)}, ${workflow.workspaceId}) ON CONFLICT(id) DO UPDATE SET data = excluded.data, workspace_id = excluded.workspace_id`;
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
  const deleteRunTasks = Effect.fn("BoardStore.deleteRunTasks")(function* (
    runIds: ReadonlyArray<string>,
  ) {
    if (runIds.length) yield* sql`DELETE FROM board_tasks WHERE run_id IN ${sql.in(runIds)}`;
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
  const getPeer = Effect.fn("BoardStore.getPeer")(function* (id: EnvironmentId) {
    const rows = yield* sql<PeerRow>`SELECT data, bearer FROM board_peers WHERE id = ${id}`;
    return rows[0] === undefined ? undefined : peerFromRow(rows[0]);
  });
  const listPairedPeers = Effect.fn("BoardStore.listPairedPeers")(function* () {
    const rows = yield* sql<PeerRow>`SELECT data, bearer FROM board_peers ORDER BY rowid`;
    return rows.map(peerFromRow);
  });
  const putPeer = Effect.fn("BoardStore.putPeer")(function* (peer: Peer) {
    const visible: BoardPeer = {
      id: peer.id,
      name: peer.name,
      environmentId: peer.environmentId,
      url: peer.url,
      status: "connected",
      ...(peer.expiresAt ? { expiresAt: peer.expiresAt } : {}),
    };
    yield* sql`INSERT INTO board_peers (id, data, bearer) VALUES (${peer.environmentId}, ${encodeJson(visible)}, ${peer.bearer}) ON CONFLICT(id) DO UPDATE SET data = excluded.data, bearer = excluded.bearer`;
    return visible;
  });
  const deletePeer = Effect.fn("BoardStore.deletePeer")(function* (id: EnvironmentId) {
    yield* sql`DELETE FROM board_peers WHERE id = ${id}`;
  });
  const updatePeerStatus = Effect.fn("BoardStore.updatePeerStatus")(function* (
    peer: Peer,
    status: BoardPeer["status"],
    error?: string,
  ) {
    const rows =
      yield* sql<PeerRow>`SELECT data, bearer FROM board_peers WHERE id = ${peer.environmentId}`;
    const row = rows[0];
    if (!row || row.bearer !== peer.bearer) return undefined;
    const current = decodeJson(row.data) as BoardPeer;
    if (current.status === status && current.error === error) return undefined;
    const { error: _previousError, ...rest } = current;
    const updated: BoardPeer = { ...rest, status, ...(error === undefined ? {} : { error }) };
    yield* sql`UPDATE board_peers SET data = ${encodeJson(updated)} WHERE id = ${peer.environmentId}`;
    return updated;
  });
  type FolderRow = {
    readonly workspace_id: string;
    readonly environment_id: string;
    readonly project_id: string;
    readonly path: string;
    readonly managed: number;
  };
  const workspacesFrom = (
    workspaces: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    folders: ReadonlyArray<FolderRow>,
  ): ReadonlyArray<Workspace> =>
    workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      folders: folders
        .filter((folder) => folder.workspace_id === workspace.id)
        .map((folder) => ({
          environmentId: folder.environment_id as EnvironmentId,
          projectId: folder.project_id as ProjectId,
          path: folder.path,
          managed: folder.managed === 1,
        })),
    }));
  const listWorkspaces = Effect.fn("BoardStore.listWorkspaces")(function* () {
    const workspaces = yield* sql<{
      readonly id: string;
      readonly name: string;
    }>`SELECT id, name FROM board_workspaces ORDER BY rowid`;
    const folders = yield* sql<FolderRow>`SELECT * FROM board_workspace_folders ORDER BY rowid`;
    return workspacesFrom(workspaces, folders);
  });
  const getWorkspace = Effect.fn("BoardStore.getWorkspace")(function* (id: string) {
    const workspaces = yield* sql<{
      readonly id: string;
      readonly name: string;
    }>`SELECT id, name FROM board_workspaces WHERE id = ${id}`;
    const folders =
      yield* sql<FolderRow>`SELECT * FROM board_workspace_folders WHERE workspace_id = ${id} ORDER BY rowid`;
    return workspacesFrom(workspaces, folders)[0];
  });
  const putWorkspace = Effect.fn("BoardStore.putWorkspace")(function* (workspace: Workspace) {
    yield* sql`INSERT INTO board_workspaces (id, name) VALUES (${workspace.id}, ${workspace.name}) ON CONFLICT(id) DO UPDATE SET name = excluded.name`;
    yield* sql`DELETE FROM board_workspace_folders WHERE workspace_id = ${workspace.id}`;
    for (const folder of workspace.folders)
      yield* sql`INSERT INTO board_workspace_folders (workspace_id, environment_id, project_id, path, managed) VALUES (${workspace.id}, ${folder.environmentId}, ${folder.projectId}, ${folder.path}, ${folder.managed ? 1 : 0})`;
  });
  const deleteWorkspace = Effect.fn("BoardStore.deleteWorkspace")(function* (id: string) {
    yield* sql`DELETE FROM board_workflows WHERE workspace_id = ${id}`;
    yield* sql`DELETE FROM board_workspaces WHERE id = ${id}`;
  });
  const listKanban = Effect.fn("BoardStore.listKanban")(function* (workflowId: string) {
    const rows =
      yield* sql<JsonRow>`SELECT data FROM board_kanban_cards WHERE workflow_id = ${workflowId} ORDER BY rowid`;
    return rows.map((row) => decodeJson(row.data) as KanbanCard);
  });
  const putCard = Effect.fn("BoardStore.putCard")(function* (workflowId: string, card: KanbanCard) {
    yield* sql`INSERT INTO board_kanban_cards (workflow_id, id, data) VALUES (${workflowId}, ${card.id}, ${encodeJson(card)}) ON CONFLICT(workflow_id, id) DO UPDATE SET data = excluded.data`;
  });
  const deleteCard = Effect.fn("BoardStore.deleteCard")(function* (
    workflowId: string,
    cardId: string,
  ) {
    yield* sql`DELETE FROM board_kanban_cards WHERE workflow_id = ${workflowId} AND id = ${cardId}`;
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
    const rows = yield* sql<{
      readonly sequence: number;
    }>`INSERT INTO board_task_events (data) VALUES (${encodeJson(event)}) RETURNING sequence`;
    const sequence = rows[0]!.sequence;
    yield* sql`DELETE FROM board_task_events WHERE sequence <= ${sequence - EVENT_RETENTION}`;
    return sequence;
  });
  const snapshot = Effect.fn("BoardStore.snapshot")(function* () {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly sequence: number;
        }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM board_task_events`;
        const workflows = yield* listWorkflows();
        const kanban = [];
        for (const workflow of workflows)
          kanban.push({ workflowId: workflow.id, cards: yield* listKanban(workflow.id) });
        return {
          sequence: rows[0]?.sequence ?? 0,
          workspaces: yield* listWorkspaces(),
          workflows,
          kanban,
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
        const oldest = yield* sql<{
          readonly sequence: number | null;
        }>`SELECT MIN(sequence) AS sequence FROM board_task_events`;
        // Replay has a gap: end the stream so the client reconnects from a fresh snapshot.
        if (oldest[0]?.sequence != null && afterSequence < oldest[0].sequence - 1) {
          return Stream.empty;
        }
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
    listWorkspaces,
    getWorkspace,
    putWorkspace,
    deleteWorkspace,
    listKanban,
    putCard,
    deleteCard,
    getWorkflow,
    listWorkflows,
    putWorkflow,
    deleteWorkflow,
    getTask,
    listTasks,
    putTask,
    deleteRunTasks,
    listPeers,
    getPeer,
    listPairedPeers,
    putPeer,
    deletePeer,
    updatePeerStatus,
    listSchedules,
    putSchedule,
    deleteSchedule,
    appendEvent,
    snapshot,
    events,
  });
});

export const layer = Layer.effect(BoardStore, make);
