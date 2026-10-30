import { assert, it } from "@effect/vitest";
import {
  BoardConflictError,
  BoardMachineUnavailableError,
  BoardInvalidRequestError,
  NodeDriverError,
  type BoardCreateNodeInput,
  type KanbanCard,
  type NodeDriver,
} from "@t3tools/board-core";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSchedules from "./AgentSchedules.ts";
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

/** t3's scheduled tasks per machine, as the drivers see them. */
const makeMachines = Effect.gen(function* () {
  const tasks = yield* Ref.make(new Map<string, ScheduledTask>());
  const offline = yield* Ref.make(new Set<EnvironmentId>());
  // A published t3 without run limits drops maxRuns.
  const stock = yield* Ref.make(new Set<EnvironmentId>());
  // Run once around the next task write, to stage what happens meanwhile.
  const beforeUpsert = yield* Ref.make<Effect.Effect<void, unknown>>(Effect.void);
  const afterUpsert = yield* Ref.make<Effect.Effect<void, unknown>>(Effect.void);
  const once = (hook: Ref.Ref<Effect.Effect<void, unknown>>) =>
    Ref.getAndSet(hook, Effect.void).pipe(Effect.flatten, Effect.orDie);
  const key = (input: { environmentId: EnvironmentId; taskId: string }) =>
    `${input.environmentId}\0${input.taskId}`;
  // Down for everything, or only for schedule calls (a machine that drops right after a launch).
  const scheduleOffline = yield* Ref.make(new Set<EnvironmentId>());
  const down =
    (sets: ReadonlyArray<Ref.Ref<Set<EnvironmentId>>>) => (environmentId: EnvironmentId) =>
      Effect.forEach(sets, Ref.get).pipe(
        Effect.flatMap((all) =>
          all.some((set) => set.has(environmentId))
            ? Effect.fail(
                new NodeDriverError({
                  operation: "schedule",
                  message: "Remote board schedule failed.",
                }),
              )
            : Effect.void,
        ),
      );
  const reach = down([offline]);
  const reachSchedules = down([offline, scheduleOffline]);
  const schedules: Pick<
    NodeDriver,
    "getScheduledTask" | "upsertScheduledTask" | "setScheduledTaskEnabled" | "deleteScheduledTask"
  > = {
    getScheduledTask: (input) =>
      reachSchedules(input.environmentId).pipe(
        Effect.andThen(Ref.get(tasks)),
        Effect.map((all) => all.get(key(input)) ?? null),
      ),
    upsertScheduledTask: ({ environmentId, task: input }) =>
      Effect.gen(function* () {
        yield* once(beforeUpsert);
        yield* reachSchedules(environmentId);
        const limited = !(yield* Ref.get(stock)).has(environmentId);
        const k = key({ environmentId, taskId: input.id });
        const existing = (yield* Ref.get(tasks)).get(k);
        const beforeRun =
          input.beforeRun === undefined ? existing?.beforeRun : (input.beforeRun ?? undefined);
        const maxRuns = limited
          ? input.maxRuns === undefined
            ? existing?.maxRuns
            : (input.maxRuns ?? undefined)
          : undefined;
        const task: ScheduledTask = {
          id: input.id,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule:
            input.schedule.type === "webhook"
              ? { type: "interval", everyMs: 60_000 }
              : input.schedule,
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdBy: "system",
          creationSource: "server",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          nextRunAt: null,
          lastRunAt: null,
          lastRunStatus: "never",
          lastRunError: null,
          runCount: existing?.runCount ?? 0,
          ...(maxRuns === undefined ? {} : { maxRuns }),
          ...(beforeRun === undefined ? {} : { beforeRun }),
        };
        yield* Ref.update(tasks, (all) => new Map(all).set(k, task));
        yield* once(afterUpsert);
        return (yield* Ref.get(tasks)).get(k) ?? task;
      }),
    setScheduledTaskEnabled: (input) =>
      reachSchedules(input.environmentId).pipe(
        Effect.andThen(
          Ref.update(tasks, (all) => {
            const task = all.get(key(input));
            return task ? new Map(all).set(key(input), { ...task, enabled: input.enabled }) : all;
          }),
        ),
      ),
    deleteScheduledTask: (input) =>
      reachSchedules(input.environmentId).pipe(
        Effect.andThen(
          Ref.update(tasks, (all) => {
            const next = new Map(all);
            next.delete(key(input));
            return next;
          }),
        ),
      ),
  };
  const fire = (environmentId: EnvironmentId, times: number) =>
    Ref.update(
      tasks,
      (all) =>
        new Map(
          [...all].map(([k, task]) => [
            k,
            k.startsWith(`${environmentId}\0`)
              ? { ...task, runCount: task.runCount + times }
              : task,
          ]),
        ),
    );
  const on = (environmentId: EnvironmentId) =>
    Ref.get(tasks).pipe(
      Effect.map((all) =>
        [...all].filter(([k]) => k.startsWith(`${environmentId}\0`)).map(([, task]) => task),
      ),
    );
  /** What a "new chat" firing does on the machine: the task moves to the fresh thread. */
  const rebind = (environmentId: EnvironmentId, threadId: string) =>
    Ref.update(
      tasks,
      (all) =>
        new Map(
          [...all].map(([k, task]) => [
            k,
            k.startsWith(`${environmentId}\0`)
              ? {
                  ...task,
                  threadId: ThreadId.make(threadId),
                  updatedAt: "2999-01-01T00:00:00.000Z",
                }
              : task,
          ]),
        ),
    );
  return {
    schedules,
    offline,
    scheduleOffline,
    stock,
    fire,
    on,
    rebind,
    beforeUpsert,
    afterUpsert,
    reach,
  };
});

const makeLayer = Effect.gen(function* () {
  const deleted = yield* Queue.unbounded<ProjectId>();
  const foldersRemoved = yield* Queue.unbounded<ProjectId>();
  const failing = yield* Ref.make<ProjectId | null>(null);
  const machines = yield* makeMachines;
  const driver: NodeDriver = {
    ...machines.schedules,
    ensureProject: () => Effect.succeed({ adopted: false }),
    projectBusy: () => Effect.succeed(false),
    deleteProject: (input) =>
      Ref.get(failing).pipe(
        Effect.flatMap((id) =>
          id === input.projectId && input.removeFolderPath !== undefined
            ? Effect.fail(new NodeDriverError({ operation: "deleteProject", message: "boom" }))
            : Effect.void,
        ),
        Effect.andThen(Queue.offer(deleted, input.projectId)),
        Effect.andThen(
          input.removeFolderPath !== undefined
            ? Queue.offer(foldersRemoved, input.projectId)
            : Effect.void,
        ),
        Effect.asVoid,
      ),
    launch: (input) =>
      machines.reach(input.environmentId).pipe(
        Effect.as({
          environmentId: input.environmentId,
          projectId: input.launch.projectId,
          threadId: input.launch.threadId,
        }),
      ),
    send: (input) => Effect.succeed({ runId: RunId.make(input.messageId), sequence: 0 }),
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
    Layer.provide(AgentSchedules.layer),
    Layer.provideMerge(TaskEngine.layer),
    Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
    Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  );
  return { deleted, foldersRemoved, failing, layer, machines };
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
          timing: { type: "interval", everyMs: 60_000 },
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

it.effect("deleting a workspace removes its folder on every machine only when asked", () =>
  Effect.gen(function* () {
    for (const removeFolders of [false, true]) {
      const { deleted, foldersRemoved, layer } = yield* makeLayer;
      yield* Effect.gen(function* () {
        const board = yield* BoardService.BoardService;
        yield* board.createWorkspace({ id: "ws", name: "Workspace" });
        yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
        yield* board.createNode("w", nodeInput("a"));
        yield* board.createNode("w", nodeInput("b", { environmentId: otherEnvironmentId }));
        const folders = (yield* board.getWorkspace("ws")).folders;
        const projectIds = folders.map((folder) => folder.projectId);
        yield* board.deleteWorkspace(
          "ws",
          removeFolders
            ? { removeFolders: folders.map(({ environmentId, path }) => ({ environmentId, path })) }
            : {},
        );
        assert.sameMembers([...(yield* Queue.takeN(deleted, 2))], projectIds);
        assert.strictEqual(yield* Queue.size(foldersRemoved), removeFolders ? 2 : 0);
        if (removeFolders)
          assert.sameMembers([...(yield* Queue.takeN(foldersRemoved, 2))], projectIds);
      }).pipe(Effect.provide(layer));
    }
  }),
);

it.effect("only the folders the user confirmed are deleted from disk", () =>
  Effect.gen(function* () {
    const { foldersRemoved, layer } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a"));
      yield* board.createNode("w", nodeInput("b", { environmentId: otherEnvironmentId }));
      const [first, second] = (yield* board.getWorkspace("ws")).folders;
      // The second folder changed path after the dialog, so what was confirmed no longer matches.
      yield* board.deleteWorkspace("ws", {
        removeFolders: [
          { environmentId: first!.environmentId, path: first!.path },
          { environmentId: second!.environmentId, path: "/somewhere/else" },
        ],
      });
      assert.deepStrictEqual([...(yield* Queue.takeN(foldersRemoved, 1))], [first!.projectId]);
      assert.strictEqual(yield* Queue.size(foldersRemoved), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a machine that cannot delete its folder keeps the whole workspace for a retry", () =>
  Effect.gen(function* () {
    const { deleted, foldersRemoved, failing, layer } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a"));
      yield* board.createNode("w", nodeInput("b", { environmentId: otherEnvironmentId }));
      const [first, second] = (yield* board.getWorkspace("ws")).folders;
      yield* Ref.set(failing, second!.projectId);
      const confirmed = (yield* board.getWorkspace("ws")).folders.map(
        ({ environmentId, path }) => ({ environmentId, path }),
      );
      const failure = yield* board
        .deleteWorkspace("ws", { removeFolders: confirmed })
        .pipe(Effect.flip);
      assert.instanceOf(failure, BoardConflictError);
      assert.include(failure.message, second!.path);
      // The other machine was still cleaned, and the board keeps the workspace.
      assert.deepStrictEqual([...(yield* Queue.takeN(foldersRemoved, 1))], [first!.projectId]);
      assert.strictEqual((yield* board.getWorkspace("ws")).id, "ws");
      yield* Ref.set(failing, null);
      yield* board.deleteWorkspace("ws", { removeFolders: confirmed });
      assert.strictEqual(yield* Queue.size(deleted), 3);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("removing one folder in settings never deletes files from disk", () =>
  Effect.gen(function* () {
    const { foldersRemoved, deleted, layer } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const store = yield* BoardStore.BoardStore;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      const workspace = yield* board.getWorkspace("ws");
      yield* store.transaction(
        store.putWorkspace({
          ...workspace,
          folders: [
            {
              environmentId,
              projectId: ProjectId.make("adopted"),
              path: "/srv/repo",
              managed: false,
            },
            {
              environmentId: otherEnvironmentId,
              projectId: ProjectId.make("made"),
              path: "/srv/made",
              managed: true,
            },
          ],
        }),
      );
      yield* board.deleteFolder("ws", environmentId);
      assert.strictEqual(yield* Queue.size(deleted), 0);
      yield* board.deleteFolder("ws", otherEnvironmentId);
      assert.deepStrictEqual([...(yield* Queue.takeN(deleted, 1))], ["made"]);
      assert.strictEqual(yield* Queue.size(foldersRemoved), 0);
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

const scheduleInput = {
  prompt: "Check the inbox.",
  timing: { type: "interval", everyMs: 120_000 },
  runs: 3,
  beforeRun: "compact",
} as const;

it.effect("an agent's schedule fires into its chat on its machine and follows /new", () =>
  Effect.gen(function* () {
    const { layer, machines } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a", { environmentId: otherEnvironmentId }));

      // The chat does not exist yet, so scheduling opens it first.
      const scheduled = yield* board.saveNodeSchedule("w", "a", scheduleInput);
      const chat = scheduled.chat!;
      const [task] = yield* machines.on(otherEnvironmentId);
      assert.deepInclude(task, {
        id: scheduled.schedule!.taskId,
        prompt: "Check the inbox.",
        threadId: chat.threadId,
        projectId: chat.projectId,
        maxRuns: 3,
        enabled: true,
        beforeRun: "compact",
      });
      assert.deepStrictEqual(task?.schedule, { type: "interval", everyMs: 120_000 });
      assert.deepStrictEqual(yield* machines.on(environmentId), []);

      const moved = yield* board.newNodeChat("w", "a", {});
      assert.notStrictEqual(moved.chat?.threadId, chat.threadId);
      const [followed] = yield* machines.on(otherEnvironmentId);
      assert.deepInclude(followed, {
        id: task!.id,
        threadId: moved.chat!.threadId,
        prompt: "Check the inbox.",
        maxRuns: 3,
      });

      // Saving again gives that many runs from now, on top of the ones the machine fired.
      yield* machines.fire(otherEnvironmentId, 2);
      yield* board.saveNodeSchedule("w", "a", { ...scheduleInput, runs: 4 });
      assert.deepInclude((yield* machines.on(otherEnvironmentId))[0], { runCount: 2, maxRuns: 6 });

      yield* board.setNodeScheduleEnabled("w", "a", false);
      assert.isFalse((yield* machines.on(otherEnvironmentId))[0]?.enabled);
      yield* board.deleteNodeSchedule("w", "a");
      assert.deepStrictEqual(yield* machines.on(otherEnvironmentId), []);
      assert.isUndefined((yield* board.getWorkflow("w")).nodes[0]?.schedule);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("deleting or moving a scheduled agent removes its task", () =>
  Effect.gen(function* () {
    const { layer, machines } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      for (const id of ["a", "b", "c"]) {
        yield* board.createNode("w", nodeInput(id));
        yield* board.saveNodeSchedule("w", id, scheduleInput);
      }
      assert.lengthOf(yield* machines.on(environmentId), 3);

      yield* board.deleteNode("w", "a");
      assert.lengthOf(yield* machines.on(environmentId), 2);
      const moved = yield* board.updateNode("w", "b", { environmentId: otherEnvironmentId });
      assert.isUndefined(moved.schedule);
      assert.lengthOf(yield* machines.on(environmentId), 1);
      yield* board.deleteWorkflow("w");
      assert.deepStrictEqual(yield* machines.on(environmentId), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("an unreachable machine fails the schedule cleanly and holds back the delete", () =>
  Effect.gen(function* () {
    const { layer, machines } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a"));
      yield* board.createNode("w", nodeInput("fresh"));
      yield* board.openNodeChat("w", "a");

      yield* Ref.set(machines.offline, new Set([environmentId]));
      const failure = yield* board.saveNodeSchedule("w", "a", scheduleInput).pipe(Effect.flip);
      assert.instanceOf(failure, BoardMachineUnavailableError);
      // An agent whose chat would first be opened there gets the same answer.
      const unopened = yield* board.saveNodeSchedule("w", "fresh", scheduleInput).pipe(Effect.flip);
      assert.instanceOf(unopened, BoardMachineUnavailableError);
      assert.include(failure.message, "Could not save the schedule");
      yield* Ref.set(machines.offline, new Set());
      assert.isUndefined((yield* board.getWorkflow("w")).nodes[0]?.schedule);
      assert.deepStrictEqual(yield* machines.on(environmentId), []);

      yield* board.saveNodeSchedule("w", "a", scheduleInput);
      yield* Ref.set(machines.offline, new Set([environmentId]));
      const held = yield* board.deleteNode("w", "a").pipe(Effect.flip);
      assert.instanceOf(held, BoardMachineUnavailableError);
      assert.isTrue((yield* board.getWorkflow("w")).nodes.some((entry) => entry.id === "a"));
      yield* Ref.set(machines.offline, new Set());
      assert.lengthOf(yield* machines.on(environmentId), 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a machine whose t3 cannot stop after N runs is refused", () =>
  Effect.gen(function* () {
    const { layer, machines } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a", { environmentId: otherEnvironmentId }));
      yield* Ref.set(machines.stock, new Set([otherEnvironmentId]));
      const failure = yield* board.saveNodeSchedule("w", "a", scheduleInput).pipe(Effect.flip);
      assert.include(failure.message, "without run limits");
      assert.deepStrictEqual(yield* machines.on(otherEnvironmentId), []);
      assert.isUndefined((yield* board.getWorkflow("w")).nodes[0]?.schedule);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "a new-chat firing on the machine moves the agent's chat, and a time of day fires once",
  () =>
    Effect.gen(function* () {
      const { layer, machines } = yield* makeLayer;
      yield* Effect.gen(function* () {
        const board = yield* BoardService.BoardService;
        yield* board.createWorkspace({ id: "ws", name: "Workspace" });
        yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
        yield* board.createNode("w", nodeInput("a"));
        yield* board.saveNodeSchedule("w", "a", {
          ...scheduleInput,
          timing: { type: "fixed_time", timeOfDay: "09:30", weekdays: [3] },
          runs: 1,
          beforeRun: "new_thread",
        });
        assert.deepInclude((yield* machines.on(environmentId))[0], {
          schedule: { type: "fixed_time", timeOfDay: "09:30", weekdays: [3] },
          maxRuns: 1,
          beforeRun: "new_thread",
        });

        yield* machines.rebind(environmentId, "fired-thread");
        yield* board.syncNodeSchedule("w", "a");
        assert.strictEqual(
          (yield* board.getWorkflow("w")).nodes[0]?.chat?.threadId,
          "fired-thread",
        );

        // A later save keeps the chat the machine moved to.
        yield* board.saveNodeSchedule("w", "a", scheduleInput);
        assert.strictEqual((yield* machines.on(environmentId))[0]?.threadId, "fired-thread");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "schedule saves stay consistent with concurrent deletes, firings and failed cleanups",
  () =>
    Effect.gen(function* () {
      const { layer, machines } = yield* makeLayer;
      yield* Effect.gen(function* () {
        const board = yield* BoardService.BoardService;
        yield* board.createWorkspace({ id: "ws", name: "Workspace" });
        yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
        for (const id of ["a", "b", "c"]) yield* board.createNode("w", nodeInput(id));

        // A delete asked for while the task is being written waits for it, then removes it.
        const deleting = yield* Deferred.make<Fiber.Fiber<void>>();
        yield* Ref.set(
          machines.beforeUpsert,
          board.deleteNode("w", "a").pipe(
            Effect.orDie,
            Effect.forkDetach,
            Effect.flatMap((fiber) => Deferred.succeed(deleting, fiber)),
          ),
        );
        yield* board.saveNodeSchedule("w", "a", scheduleInput);
        yield* Fiber.join(yield* Deferred.await(deleting));
        assert.deepStrictEqual(yield* machines.on(environmentId), []);
        assert.isFalse((yield* board.getWorkflow("w")).nodes.some((node) => node.id === "a"));

        // A firing between the read and the write does not eat into the granted runs.
        yield* board.saveNodeSchedule("w", "b", scheduleInput);
        yield* Ref.set(machines.afterUpsert, machines.fire(environmentId, 1));
        yield* board.saveNodeSchedule("w", "b", { ...scheduleInput, runs: 2 });
        assert.deepInclude((yield* machines.on(environmentId))[0], { runCount: 1, maxRuns: 3 });

        // A move that is then rejected keeps the schedule.
        const rejected = yield* board
          .updateNode("w", "b", { environmentId: otherEnvironmentId, name: "c" })
          .pipe(Effect.flip);
        assert.instanceOf(rejected, BoardConflictError);
        assert.lengthOf(yield* machines.on(environmentId), 1);
        assert.isDefined((yield* board.getWorkflow("w")).nodes.find((n) => n.id === "b")?.schedule);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("an unlimited task that cannot be removed stays marked for a later delete", () =>
  Effect.gen(function* () {
    const { layer, machines } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a", { environmentId: otherEnvironmentId }));
      yield* Ref.set(machines.stock, new Set([otherEnvironmentId]));
      yield* Ref.set(
        machines.afterUpsert,
        Ref.set(machines.offline, new Set([otherEnvironmentId])),
      );
      yield* board.saveNodeSchedule("w", "a", scheduleInput).pipe(Effect.flip);
      assert.isDefined((yield* board.getWorkflow("w")).nodes[0]?.schedule);
      yield* Ref.set(machines.offline, new Set());
      yield* board.deleteNode("w", "a");
      assert.deepStrictEqual(yield* machines.on(otherEnvironmentId), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a /new that could not reach the machine is caught up on the next sync", () =>
  Effect.gen(function* () {
    const { layer, machines } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a"));
      yield* board.saveNodeSchedule("w", "a", { ...scheduleInput, beforeRun: "new_thread" });
      // A firing moved the task before the board noticed, then "/new" could not reach the machine.
      yield* machines.rebind(environmentId, "fired-thread");
      yield* Ref.set(machines.scheduleOffline, new Set([environmentId]));
      yield* board.newNodeChat("w", "a", { interactionMode: "plan" }).pipe(Effect.flip);
      yield* Ref.set(machines.scheduleOffline, new Set());
      const chat = (yield* board.getWorkflow("w")).nodes[0]?.chat;
      yield* board.syncNodeSchedule("w", "a");
      assert.strictEqual((yield* board.getWorkflow("w")).nodes[0]?.chat?.threadId, chat?.threadId);
      assert.deepInclude((yield* machines.on(environmentId))[0], {
        threadId: chat!.threadId,
        interactionMode: "plan",
      });
      assert.isUndefined((yield* board.getWorkflow("w")).nodes[0]?.schedule?.rebind);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("deleting agents on two machines removes nothing while one is offline", () =>
  Effect.gen(function* () {
    const { layer, machines } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a"));
      yield* board.createNode("w", nodeInput("b", { environmentId: otherEnvironmentId }));
      yield* board.saveNodeSchedule("w", "a", scheduleInput);
      yield* board.saveNodeSchedule("w", "b", scheduleInput);
      yield* Ref.set(machines.offline, new Set([otherEnvironmentId]));
      yield* board.deleteWorkflow("w").pipe(Effect.flip);
      assert.lengthOf(yield* machines.on(environmentId), 1);
      yield* Ref.set(machines.offline, new Set());
      yield* board.deleteWorkflow("w");
      assert.deepStrictEqual(yield* machines.on(environmentId), []);
      assert.deepStrictEqual(yield* machines.on(otherEnvironmentId), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("/new binds the schedule to the new chat even after a firing moved it", () =>
  Effect.gen(function* () {
    const { layer, machines } = yield* makeLayer;
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* board.createWorkspace({ id: "ws", name: "Workspace" });
      yield* board.createWorkflow({ id: "w", name: "W", workspaceId: "ws" });
      yield* board.createNode("w", nodeInput("a"));
      yield* board.saveNodeSchedule("w", "a", { ...scheduleInput, beforeRun: "new_thread" });
      yield* machines.rebind(environmentId, "fired-thread");
      const fresh = yield* board.newNodeChat("w", "a", { interactionMode: "plan" });
      const node = (yield* board.getWorkflow("w")).nodes[0];
      assert.strictEqual(node?.chat?.threadId, fresh.chat?.threadId);
      assert.deepInclude((yield* machines.on(environmentId))[0], {
        threadId: fresh.chat!.threadId,
        interactionMode: "plan",
      });
    }).pipe(Effect.provide(layer));
  }),
);
