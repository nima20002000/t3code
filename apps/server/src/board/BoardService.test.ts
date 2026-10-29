import { assert, it } from "@effect/vitest";
import {
  BoardConflictError,
  BoardInvalidRequestError,
  type BoardCreateNodeInput,
  type KanbanCard,
  type NodeDriver,
} from "@t3tools/board-core";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardService from "./BoardService.ts";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as TaskEngine from "./TaskEngine.ts";

const environmentId = EnvironmentId.make("environment:test");
const otherEnvironmentId = EnvironmentId.make("environment:other");
const nodeInput = (
  id: string,
  patch: Partial<BoardCreateNodeInput> = {},
): BoardCreateNodeInput => ({
  id,
  name: id,
  profile: "worker",
  environmentId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  x: 0,
  y: 0,
  ...patch,
});
const card = (id: string, assigneeNodeId?: string): KanbanCard => ({
  id,
  title: id,
  body: "",
  status: "todo",
  ...(assigneeNodeId === undefined ? {} : { assigneeNodeId }),
  updatedBy: "engine",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeLayer = Effect.gen(function* () {
  const deleted = yield* Queue.unbounded<ProjectId>();
  const driver: NodeDriver = {
    ensureProject: () => Effect.succeed({ adopted: false }),
    deleteProject: (input) => Queue.offer(deleted, input.projectId).pipe(Effect.asVoid),
    launch: (input) =>
      Effect.succeed({
        environmentId: input.environmentId,
        projectId: input.launch.projectId,
        threadId: input.launch.threadId,
      }),
    send: (input) => Effect.succeed({ runId: RunId.make(input.messageId), sequence: 0 }),
    resume: () => Effect.succeed(null),
    subscribeSettled: () => Stream.empty,
    readLatestAssistant: () => Effect.succeed(null),
    interrupt: () => Effect.void,
  };
  const registry = DriverRegistry.DriverRegistry.of({
    get: (id) =>
      id === environmentId || id === otherEnvironmentId
        ? Effect.succeed(driver)
        : Effect.die("unknown machine"),
    register: () => Effect.void,
    remove: () => Effect.void,
  });
  const layer = BoardService.layer.pipe(
    Layer.provideMerge(TaskEngine.layer),
    Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
    Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  );
  return { deleted, layer };
});

it.effect("workspaces own workflows, need unique names, and get a folder per machine", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Big Project" });
      const duplicate = yield* board
        .createWorkspace({ id: "ws2", name: " big project " })
        .pipe(Effect.flip);
      assert.instanceOf(duplicate, BoardConflictError);
      const missing = yield* board
        .createWorkflow({ id: "w", name: "W", workspaceId: "nope" })
        .pipe(Effect.flip);
      assert.strictEqual(missing._tag, "BoardNotFoundError");
      const workflow = yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      assert.strictEqual(workflow.workspaceId, "ws");

      yield* board.createNode("w", nodeInput("a"));
      yield* board.createNode("w", nodeInput("b"));
      yield* board.createNode("w", nodeInput("c", { environmentId: otherEnvironmentId }));
      const workspace = yield* board.getWorkspace("ws");
      assert.deepStrictEqual(
        workspace.folders.map((folder) => [folder.environmentId, folder.path, folder.managed]),
        [
          [environmentId, "~/t3-workspaces/big-project", true],
          [otherEnvironmentId, "~/t3-workspaces/big-project", true],
        ],
      );
      assert.notStrictEqual(workspace.folders[0]?.projectId, workspace.folders[1]?.projectId);

      const conflict = yield* board.addFolder("ws", { environmentId }).pipe(Effect.flip);
      assert.instanceOf(conflict, BoardConflictError);
      const inUse = yield* board.deleteFolder("ws", environmentId).pipe(Effect.flip);
      assert.instanceOf(inUse, BoardConflictError);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a workflow has at most one orchestrator, and a machine must be connected", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("lead", { profile: "orchestrator" }));
      const second = yield* board
        .createNode("w", nodeInput("lead2", { profile: "orchestrator" }))
        .pipe(Effect.flip);
      assert.instanceOf(second, BoardInvalidRequestError);
      assert.include(second.message, "at most one orchestrator");
      const demoted = yield* board.updateNode("w", "lead", { profile: "worker" });
      assert.strictEqual(demoted.profile, "worker");
      const promoted = yield* board.createNode(
        "w",
        nodeInput("lead2", { profile: "orchestrator" }),
      );
      assert.strictEqual(promoted.profile, "orchestrator");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "deleting a workspace removes its workflows, runs, schedules, kanban and managed projects",
  () =>
    Effect.gen(function* () {
      const { deleted, layer } = yield* makeLayer;
      yield* Effect.gen(function* () {
        const board = yield* BoardService.BoardService;
        const store = yield* BoardStore.BoardStore;
        yield* board.createWorkspace({ id: "ws", name: "Doomed" });
        yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
        yield* board.createNode("w", nodeInput("a"));
        yield* board.createSchedule({
          id: "s",
          workflowId: "w",
          task: "Work",
          everyMs: 60_000,
          enabled: true,
        });
        const workflow = (yield* store.getWorkflow("w"))!;
        yield* store.transaction(
          Effect.gen(function* () {
            yield* store.putCard("w", card("c1"));
            // A linked (not board-created) folder must keep its project.
            const workspace = (yield* store.getWorkspace("ws"))!;
            yield* store.putWorkspace({
              ...workspace,
              folders: [
                ...workspace.folders,
                {
                  environmentId: otherEnvironmentId,
                  projectId: ProjectId.make("user-project"),
                  path: "",
                  managed: false,
                },
              ],
            });
            yield* store.putWorkflow({
              ...workflow,
              runs: [
                {
                  id: "old-run",
                  nodeId: "a",
                  nodeName: "a",
                  task: "Old",
                  status: "finished",
                  startedAt: "2026-01-01T00:00:00.000Z",
                  requests: [],
                  threads: {},
                  definition: {
                    nodes: workflow.nodes,
                    edges: workflow.edges,
                    settings: workflow.settings,
                  },
                },
              ],
            });
          }),
        );
        yield* store.transaction(
          store.putTask({
            id: "old-run",
            workflowId: "w",
            runId: "old-run",
            kind: "run",
            owner: null,
            nodeId: "a",
            status: "done",
            checkpoint: {},
            waitOn: [],
            waitPolicy: "allSettled",
          }),
        );
        const projectId = (yield* store.getWorkspace("ws"))!.folders[0]!.projectId;
        const sequence = (yield* store.snapshot()).sequence;

        yield* board.deleteWorkspace("ws");

        assert.strictEqual(yield* Queue.take(deleted), projectId);
        assert.strictEqual(yield* Queue.size(deleted), 0);
        const snapshot = yield* store.snapshot();
        assert.deepStrictEqual(snapshot.workspaces, []);
        assert.deepStrictEqual(snapshot.workflows, []);
        assert.deepStrictEqual(snapshot.schedules, []);
        assert.deepStrictEqual(yield* store.listKanban("w"), []);
        assert.deepStrictEqual(yield* store.listTasks(), []);
        const kinds = (yield* store.events(sequence).pipe(Stream.take(3), Stream.runCollect)).map(
          (event) => event.kind,
        );
        assert.sameMembers(kinds, ["schedule.deleted", "workflow.deleted", "workspace.deleted"]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("a workspace with an active run cannot be deleted", () =>
  Effect.gen(function* () {
    const { deleted, layer } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const store = yield* BoardStore.BoardStore;
      yield* board.createWorkspace({ id: "ws", name: "Busy" });
      const workflow = yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* store.transaction(
        store.putWorkflow({
          ...workflow,
          runs: [
            {
              id: "run",
              nodeId: "a",
              nodeName: "a",
              task: "Busy",
              status: "running",
              startedAt: "2026-01-01T00:00:00.000Z",
              requests: [],
              threads: {},
              definition: { nodes: [], edges: [], settings: workflow.settings },
            },
          ],
        }),
      );
      const failure = yield* board.deleteWorkspace("ws").pipe(Effect.flip);
      assert.instanceOf(failure, BoardConflictError);
      assert.strictEqual(yield* Queue.size(deleted), 0);
      assert.isDefined(yield* store.getWorkspace("ws"));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("deleting a node unassigns its kanban cards", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const store = yield* BoardStore.BoardStore;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a"));
      yield* board.createNode("w", nodeInput("b"));
      yield* store.transaction(
        Effect.all([store.putCard("w", card("c1", "a")), store.putCard("w", card("c2", "b"))]),
      );
      yield* board.deleteNode("w", "a");
      assert.deepStrictEqual(
        (yield* board.getKanban("w")).map((entry) => [entry.id, entry.assigneeNodeId]),
        [
          ["c1", undefined],
          ["c2", "b"],
        ],
      );
      const missing = yield* board.getKanban("nope").pipe(Effect.flip);
      assert.strictEqual(missing._tag, "BoardNotFoundError");
    }).pipe(Effect.provide(layer));
  }),
);
