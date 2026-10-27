import { assert, it } from "@effect/vitest";
import {
  createWorkflow,
  NodeDriverError,
  type BoardDriverSend,
  type BoardDriverSettled,
  type BoardNode,
  type NodeDriver,
} from "@t3tools/board-core";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as TaskEngine from "./TaskEngine.ts";
import * as BoardScheduler from "./BoardScheduler.ts";
import * as BoardService from "./BoardService.ts";

const environmentId = EnvironmentId.make("environment:test");
const node = (id: string, profile: BoardNode["profile"] = "worker"): BoardNode => ({
  id,
  name: id,
  profile,
  environmentId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  x: 0,
  y: 0,
});
const workspace = { id: "workspace", name: "Workspace", folders: [] };
const seed = (
  store: BoardStore.BoardStore["Service"],
  workflow: ReturnType<typeof setupWorkflow>,
) => store.putWorkspace(workspace).pipe(Effect.andThen(store.putWorkflow(workflow)));
const definitionOf = () => {
  const { nodes, edges, settings } = setupWorkflow();
  return { nodes, edges, settings };
};
const finish = '```json\n{"summary":"finished","data":42,"routing":{"kind":"finish"}}\n```';
const request =
  '```json\n{"summary":"delegate","data":null,"routing":{"kind":"request","requests":[{"to":"one","task":"first"},{"to":"two","task":"second"}]}}\n```';
const returned = (summary: string) =>
  `\`\`\`json\n{"summary":"${summary}","data":null,"routing":{"kind":"return"}}\n\`\`\``;

const makeHarness = Effect.gen(function* () {
  const sends = yield* Queue.unbounded<BoardDriverSend>();
  const interrupts = yield* Queue.unbounded<ThreadId>();
  const launches = yield* Queue.unbounded<Parameters<NodeDriver["launch"]>[0]>();
  const projects = yield* Queue.unbounded<Parameters<NodeDriver["ensureProject"]>[0]>();
  const replies = new Map<ThreadId, Queue.Queue<BoardDriverSettled>>();
  // A thread's queue exists once the engine launched it.
  const queueFor = (threadId: ThreadId) => replies.get(threadId)!;
  const messages = yield* Ref.make(new Map<RunId, string>());
  const driver: NodeDriver = {
    ensureProject: (input) => Queue.offer(projects, input).pipe(Effect.as({ adopted: false })),
    deleteProject: () => Effect.void,
    launch: (input) =>
      Effect.gen(function* () {
        if (!replies.has(input.launch.threadId))
          replies.set(input.launch.threadId, yield* Queue.unbounded<BoardDriverSettled>());
        yield* Queue.offer(launches, input);
      }).pipe(
        Effect.as({
          environmentId: input.environmentId,
          projectId: input.launch.projectId,
          threadId: input.launch.threadId,
        }),
      ),
    send: (input) =>
      Queue.offer(sends, input).pipe(
        Effect.as({ runId: RunId.make(input.messageId), sequence: 0 }),
      ),
    subscribeSettled: ({ thread: target }) => Stream.fromQueue(queueFor(target.threadId)),
    readLatestAssistant: ({ runId }) =>
      Ref.get(messages).pipe(
        Effect.map((all) => {
          const text = runId === undefined ? undefined : all.get(runId);
          return text === undefined ? null : { id: MessageId.make(`answer:${runId}`), text };
        }),
      ),
    interrupt: ({ thread: target }) => Queue.offer(interrupts, target.threadId).pipe(Effect.asVoid),
  };
  const registry = DriverRegistry.DriverRegistry.of({
    get: () => Effect.succeed(driver),
    register: () => Effect.void,
    remove: () => Effect.void,
  });
  const reply = (
    sent: BoardDriverSend,
    text: string,
    status: BoardDriverSettled["status"] = "completed",
  ) =>
    Effect.gen(function* () {
      const runId = RunId.make(sent.messageId);
      yield* Ref.update(messages, (current) => new Map(current).set(runId, text));
      yield* Queue.offer(queueFor(sent.thread.threadId), {
        thread: sent.thread,
        runId,
        messageId: sent.messageId,
        sequence: 1,
        status,
      });
    });
  return { sends, interrupts, launches, projects, reply, registry, driver };
});

const setupWorkflow = (
  waitPolicy: "allSettled" | "failFast" = "allSettled",
  limit: number | null = null,
) => ({
  ...createWorkflow("workflow", "Workflow", "workspace"),
  nodes: [node("root", "orchestrator"), node("one"), node("two")],
  edges: [
    { a: "root", b: "one" },
    { a: "root", b: "two" },
  ],
  settings: {
    ...createWorkflow("workflow", "Workflow", "workspace").settings,
    waitPolicy,
    maxHandoffsPerEdge: limit,
  },
});

const waitForRun = (
  store: BoardStore.BoardStore["Service"],
  predicate: (run: import("@t3tools/board-core").RunRecord) => boolean,
) =>
  store.events(0).pipe(
    Stream.filter((event) => event.kind === "run.upserted" && predicate(event.run)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect("removes schedules when their node or workflow is deleted", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = BoardService.layer.pipe(
      Layer.provideMerge(TaskEngine.layer),
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      for (const nodeId of ["root", "one"]) {
        yield* board.createSchedule({
          id: `schedule:${nodeId}`,
          workflowId: "workflow",
          nodeId,
          task: "Work",
          everyMs: 60_000,
          enabled: true,
        });
      }
      yield* board.deleteNode("workflow", "one");
      assert.deepStrictEqual(
        (yield* board.listSchedules()).map((entry) => entry.id),
        ["schedule:root"],
      );
      yield* board.deleteWorkflow("workflow");
      assert.deepStrictEqual(yield* board.listSchedules(), []);
      const deleted = yield* store.events(0).pipe(
        Stream.filter((event) => event.kind === "schedule.deleted"),
        Stream.take(2),
        Stream.runCollect,
      );
      assert.deepStrictEqual(
        deleted.map((event) => event.kind === "schedule.deleted" && event.scheduleId),
        ["schedule:one", "schedule:root"],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("joins all child returns before sending one combined message", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const storeLayer = BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(storeLayer),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:join", nodeId: "root", task: "Delegate" });
      const root = yield* Queue.take(harness.sends);
      yield* harness.reply(root, request);
      const first = yield* Queue.take(harness.sends);
      const second = yield* Queue.take(harness.sends);
      yield* harness.reply(first, returned("first result"));
      yield* waitForRun(
        store,
        (run) => run.requests.filter((entry) => entry.status === "returned").length === 1,
      );
      assert.strictEqual((yield* store.getTask("run:join"))?.status, "waiting");
      yield* harness.reply(second, returned("second result"));
      const joined = yield* Queue.take(harness.sends);
      assert.strictEqual(joined.thread.threadId, root.thread.threadId);
      assert.include(joined.text, "first result");
      assert.include(joined.text, "second result");
      yield* harness.reply(joined, finish);
      const event = yield* waitForRun(store, (run) => run.status === "finished");
      assert.strictEqual(event.kind, "run.upserted");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("failFast stops siblings when a child fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow("failFast")));
      yield* engine.start("workflow", { id: "run:fail-fast", nodeId: "root", task: "Delegate" });
      yield* harness.reply(yield* Queue.take(harness.sends), request);
      const first = yield* Queue.take(harness.sends);
      const second = yield* Queue.take(harness.sends);
      yield* harness.reply(first, "", "failed");
      assert.strictEqual(yield* Queue.take(harness.interrupts), second.thread.threadId);
      yield* waitForRun(store, (run) => run.status === "failed");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("joins the latest child results if a return commits during the join", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const store = yield* BoardStore.BoardStore;
    const holdRead = yield* Ref.make(false);
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Queue.unbounded<ThreadId>();
    const driver: NodeDriver = {
      ...harness.driver,
      subscribeSettled: (input) =>
        Stream.unwrap(
          Queue.offer(subscribed, input.thread.threadId).pipe(
            Effect.as(harness.driver.subscribeSettled(input)),
          ),
        ),
    };
    const registry = DriverRegistry.DriverRegistry.of({
      get: () => Effect.succeed(driver),
      register: () => Effect.void,
      remove: () => Effect.void,
    });
    const observedStore = BoardStore.BoardStore.of({
      ...store,
      getWorkflow: (id) =>
        Effect.gen(function* () {
          const workflow = yield* store.getWorkflow(id);
          if (yield* Ref.getAndSet(holdRead, false)) {
            yield* Deferred.succeed(reading, undefined);
            yield* Deferred.await(release);
          }
          return workflow;
        }),
    });
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
      Layer.provide(Layer.succeed(BoardStore.BoardStore, observedStore)),
    );
    yield* store.transaction(seed(store, setupWorkflow()));
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      yield* engine.start("workflow", { id: "run:join-race", nodeId: "root", task: "Delegate" });
      const root = yield* Queue.take(harness.sends);
      yield* Queue.take(subscribed);
      yield* harness.reply(root, request);
      const first = yield* Queue.take(harness.sends);
      const second = yield* Queue.take(harness.sends);
      yield* Queue.take(subscribed);
      yield* Queue.take(subscribed);
      yield* harness.reply(first, returned("first result"));
      yield* waitForRun(
        store,
        (run) => run.requests.filter((entry) => entry.status === "returned").length === 1,
      );
      yield* Ref.set(holdRead, true);
      const workflow = (yield* store.getWorkflow("workflow"))!;
      yield* store.transaction(
        store.appendEvent({
          kind: "run.upserted",
          workflowId: workflow.id,
          run: workflow.runs[0]!,
        }),
      );
      yield* Deferred.await(reading);
      yield* harness.reply(second, returned("second result"));
      yield* waitForRun(
        store,
        (run) => run.requests.filter((entry) => entry.status === "returned").length === 2,
      );
      yield* Deferred.succeed(release, undefined);
      const joined = yield* Queue.take(harness.sends);
      assert.include(joined.text, "first result");
      assert.include(joined.text, "second result");
      yield* harness.reply(joined, finish);
      yield* waitForRun(store, (run) => run.status === "finished");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("stops all active tasks and interrupts their threads", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:stop", nodeId: "root", task: "Delegate" });
      yield* harness.reply(yield* Queue.take(harness.sends), request);
      const stoppedOne = yield* Queue.take(harness.sends);
      const stoppedTwo = yield* Queue.take(harness.sends);
      const stopped = yield* engine.stop("workflow", "run:stop");
      assert.strictEqual(stopped.status, "stopped");
      assert.isTrue(
        (yield* store.listTasks("run:stop")).every((task) => task.status === "stopped"),
      );
      const interrupted = [
        yield* Queue.take(harness.interrupts),
        yield* Queue.take(harness.interrupts),
      ];
      assert.deepStrictEqual(
        new Set(interrupted),
        new Set([stoppedOne.thread.threadId, stoppedTwo.thread.threadId]),
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retries an interrupted stop after restart with the same command ID", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const calls = yield* Queue.unbounded<Parameters<NodeDriver["interrupt"]>[0]>();
    const firstCall = yield* Ref.make(true);
    const never = yield* Deferred.make<void>();
    const driver: NodeDriver = {
      ...harness.driver,
      interrupt: (input) =>
        Effect.gen(function* () {
          yield* Queue.offer(calls, input);
          if (yield* Ref.getAndSet(firstCall, false)) yield* Deferred.await(never);
        }),
    };
    const registry = DriverRegistry.DriverRegistry.of({
      get: () => Effect.succeed(driver),
      register: () => Effect.void,
      remove: () => Effect.void,
    });
    const store = yield* BoardStore.BoardStore;
    yield* store.transaction(seed(store, setupWorkflow()));
    const engineLayer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(BoardStore.BoardStore, store)),
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
    );
    const first = yield* Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* TaskEngine.TaskEngine;
        yield* engine.start("workflow", { id: "run:stop-recovery", nodeId: "root", task: "Hold" });
        yield* Queue.take(harness.sends);
        yield* engine.stop("workflow", "run:stop-recovery").pipe(Effect.forkScoped);
        return yield* Queue.take(calls);
      }).pipe(Effect.provide(engineLayer)),
    );
    const sequence = (yield* store.snapshot()).sequence;
    assert.strictEqual((yield* store.getTask("run:stop-recovery"))?.status, "completing");
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* TaskEngine.TaskEngine;
        const replay = yield* Queue.take(calls);
        assert.strictEqual(replay.commandId, first.commandId);
        assert.strictEqual(replay.runId, first.runId);
        yield* store.events(sequence).pipe(Stream.runHead);
        assert.strictEqual((yield* store.getTask("run:stop-recovery"))?.status, "stopped");
      }).pipe(Effect.provide(engineLayer)),
    );
  }).pipe(Effect.provide(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("allows a failed stop to be retried without restarting", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const calls = yield* Queue.unbounded<Parameters<NodeDriver["interrupt"]>[0]>();
    const firstCall = yield* Ref.make(true);
    const driver: NodeDriver = {
      ...harness.driver,
      interrupt: (input) =>
        Effect.gen(function* () {
          yield* Queue.offer(calls, input);
          if (yield* Ref.getAndSet(firstCall, false))
            return yield* new NodeDriverError({
              operation: "interrupt",
              message: "Temporary failure",
            });
        }),
    };
    const registry = DriverRegistry.DriverRegistry.of({
      get: () => Effect.succeed(driver),
      register: () => Effect.void,
      remove: () => Effect.void,
    });
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:stop-retry", nodeId: "root", task: "Hold" });
      yield* Queue.take(harness.sends);
      yield* engine.stop("workflow", "run:stop-retry").pipe(Effect.flip);
      assert.strictEqual((yield* store.getTask("run:stop-retry"))?.status, "completing");
      assert.strictEqual((yield* store.getWorkflow("workflow"))?.runs[0]?.status, "stopping");
      yield* engine.stop("workflow", "run:stop-retry");
      assert.strictEqual((yield* store.getWorkflow("workflow"))?.runs[0]?.status, "stopped");
      const first = yield* Queue.take(calls);
      const second = yield* Queue.take(calls);
      assert.strictEqual(first.commandId, second.commandId);
      assert.strictEqual((yield* store.getTask("run:stop-retry"))?.status, "stopped");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("records capped requests as denied and returns them to the requester", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow("allSettled", 0)));
      yield* engine.start("workflow", { id: "run:capped", nodeId: "root", task: "Delegate" });
      const rootSend = yield* Queue.take(harness.sends);
      yield* harness.reply(rootSend, request);
      const response = yield* Queue.take(harness.sends);
      assert.strictEqual(response.thread.threadId, rootSend.thread.threadId);
      assert.include(response.text, "Handoff limit 0 reached");
      yield* harness.reply(response, finish);
      const event = yield* waitForRun(store, (run) => run.status === "finished");
      assert.strictEqual(event.kind, "run.upserted");
      if (event.kind === "run.upserted")
        assert.deepStrictEqual(
          event.run.requests.map((entry) => entry.status),
          ["denied", "denied"],
        );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("replays an interrupted dispatch with the same command and message IDs", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const calls = yield* Queue.unbounded<BoardDriverSend>();
    const accepted = yield* Ref.make<ReadonlySet<string>>(new Set());
    const never = yield* Deferred.make<void>();
    const driver: NodeDriver = {
      ...harness.driver,
      send: (input) =>
        Effect.gen(function* () {
          const first = yield* Ref.modify(accepted, (current) =>
            current.has(input.commandId)
              ? ([false, current] as const)
              : ([true, new Set([...current, input.commandId])] as const),
          );
          yield* Queue.offer(calls, input);
          if (first) yield* Deferred.await(never);
          return { runId: RunId.make(input.messageId), sequence: 0 };
        }),
    };
    const registry = DriverRegistry.DriverRegistry.of({
      get: () => Effect.succeed(driver),
      register: () => Effect.void,
      remove: () => Effect.void,
    });
    const store = yield* BoardStore.BoardStore;
    yield* store.transaction(seed(store, setupWorkflow()));
    const engineLayer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(BoardStore.BoardStore, store)),
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
    );
    const first = yield* Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* TaskEngine.TaskEngine;
        yield* engine.start("workflow", { id: "run:recovery", nodeId: "root", task: "Recover" });
        return yield* Queue.take(calls);
      }).pipe(Effect.provide(engineLayer)),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* TaskEngine.TaskEngine;
        const replay = yield* Queue.take(calls);
        assert.strictEqual(replay.commandId, first.commandId);
        assert.strictEqual(replay.messageId, first.messageId);
        assert.strictEqual((yield* Ref.get(accepted)).size, 1);
        yield* harness.reply(replay, finish);
        yield* waitForRun(store, (run) => run.status === "finished");
      }).pipe(Effect.provide(engineLayer)),
    );
  }).pipe(Effect.provide(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("starts due schedules without a client and advances the persisted deadline", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = BoardScheduler.layer.pipe(
      Layer.provideMerge(TaskEngine.layer),
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(
        Effect.gen(function* () {
          yield* seed(store, setupWorkflow());
          yield* store.putSchedule({
            id: "schedule",
            workflowId: "workflow",
            nodeId: "root",
            task: "Scheduled task",
            everyMs: 60_000,
            enabled: true,
            nextRunAt: DateTime.formatIso(yield* DateTime.now),
          });
        }),
      );
      yield* TestClock.adjust("5 seconds");
      const sent = yield* Queue.take(harness.sends);
      assert.include(sent.text, "Scheduled task");
      const event = yield* store.events(0).pipe(
        Stream.filter((entry) => entry.kind === "schedule.upserted"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.strictEqual(event.kind, "schedule.upserted");
      if (event.kind === "schedule.upserted") assert.notStrictEqual(event.schedule.nextRunAt, null);
      yield* harness.reply(sent, finish);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retries persisted stop intents in the background", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const firstCall = yield* Ref.make(true);
    const driver: NodeDriver = {
      ...harness.driver,
      interrupt: (input) =>
        Ref.getAndSet(firstCall, false).pipe(
          Effect.flatMap((first) =>
            first
              ? Effect.fail(new NodeDriverError({ operation: "interrupt", message: "Offline" }))
              : harness.driver.interrupt(input),
          ),
        ),
    };
    const registry = DriverRegistry.DriverRegistry.of({
      get: () => Effect.succeed(driver),
      register: () => Effect.void,
      remove: () => Effect.void,
    });
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:bg-stop", nodeId: "root", task: "Hold" });
      yield* Queue.take(harness.sends);
      yield* engine.stop("workflow", "run:bg-stop").pipe(Effect.flip);
      yield* TestClock.adjust("30 seconds");
      yield* waitForRun(store, (run) => run.status === "stopped");
      assert.strictEqual((yield* store.getTask("run:bg-stop"))?.status, "stopped");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("stop cancels every active run of the workflow", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:a", nodeId: "root", task: "A" });
      yield* Queue.take(harness.sends);
      yield* engine.start("workflow", { id: "run:b", nodeId: "root", task: "B" });
      yield* Queue.take(harness.sends);
      yield* engine.stop("workflow", "run:a");
      const runs = (yield* store.getWorkflow("workflow"))?.runs ?? [];
      assert.deepStrictEqual(
        runs.map((run) => run.status),
        ["stopped", "stopped"],
      );
      yield* Queue.take(harness.interrupts);
      yield* Queue.take(harness.interrupts);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("returns the existing run when a start is repeated with the same id", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      const input = { id: "run:again", nodeId: "root", task: "Once" };
      const first = yield* engine.start("workflow", input);
      yield* Queue.take(harness.sends);
      const repeated = yield* engine.start("workflow", input);
      assert.deepStrictEqual([repeated.id, repeated.status], [first.id, "running"]);
      const conflict = yield* engine
        .start("workflow", { ...input, task: "Other" })
        .pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "BoardConflictError");
      assert.strictEqual((yield* store.getWorkflow("workflow"))?.runs.length, 1);
      assert.strictEqual(yield* Queue.size(harness.sends), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps only the last 50 finished runs and never prunes active ones", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      const old = (index: number, status: "finished" | "running") => ({
        id: `old:${index}`,
        nodeId: "root",
        nodeName: "root",
        task: "Old",
        status,
        startedAt: "2020-01-01T00:00:00.000Z",
        requests: [],
        threads: {},
        definition: definitionOf(),
      });
      yield* store.transaction(
        seed(store, {
          ...setupWorkflow(),
          runs: [
            old(-1, "running"),
            ...Array.from({ length: 60 }, (_, index) => old(index, "finished")),
          ],
        }),
      );
      const oldTask = (runId: string) => ({
        id: runId,
        workflowId: "workflow",
        runId,
        kind: "run" as const,
        owner: null,
        nodeId: "root",
        status: "done" as const,
        checkpoint: {},
        waitOn: [],
        waitPolicy: "allSettled" as const,
      });
      yield* store.transaction(
        Effect.all([store.putTask(oldTask("old:0")), store.putTask(oldTask("old:59"))]),
      );
      yield* engine.start("workflow", { id: "run:new", nodeId: "root", task: "New" });
      assert.deepStrictEqual(yield* store.listTasks("old:0"), []);
      assert.strictEqual((yield* store.listTasks("old:59")).length, 1);
      const runs = (yield* store.getWorkflow("workflow"))?.runs ?? [];
      assert.strictEqual(runs.filter((run) => run.status === "finished").length, 50);
      assert.deepStrictEqual(
        runs.filter((run) => run.status === "running").map((run) => run.id),
        ["old:-1", "run:new"],
      );
      assert.isTrue(runs.some((run) => run.id === "old:59"));
      assert.isFalse(runs.some((run) => run.id === "old:0"));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retries an uncertain send with the same ids instead of failing the task", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const calls = yield* Queue.unbounded<BoardDriverSend>();
    const firstCall = yield* Ref.make(true);
    const driver: NodeDriver = {
      ...harness.driver,
      send: (input) =>
        Queue.offer(calls, input).pipe(
          Effect.andThen(Ref.getAndSet(firstCall, false)),
          Effect.flatMap((first) =>
            first
              ? Effect.fail(
                  new NodeDriverError({ operation: "send", message: "Lost", retryable: true }),
                )
              : harness.driver.send(input),
          ),
        ),
    };
    const registry = DriverRegistry.DriverRegistry.of({
      get: () => Effect.succeed(driver),
      register: () => Effect.void,
      remove: () => Effect.void,
    });
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:uncertain", nodeId: "root", task: "Go" });
      const first = yield* Queue.take(calls);
      yield* TestClock.adjust("15 seconds");
      const second = yield* Queue.take(calls);
      assert.strictEqual(second.commandId, first.commandId);
      assert.strictEqual(second.messageId, first.messageId);
      assert.strictEqual((yield* store.getTask("run:uncertain"))?.status, "running");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("interrupts the thread when Stop lands while an uncertain send waits to retry", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const calls = yield* Queue.unbounded<BoardDriverSend>();
    const interrupts = yield* Queue.unbounded<Parameters<NodeDriver["interrupt"]>[0]>();
    const driver: NodeDriver = {
      ...harness.driver,
      send: (input) =>
        Queue.offer(calls, input).pipe(
          Effect.andThen(
            Effect.fail(
              new NodeDriverError({ operation: "send", message: "Lost", retryable: true }),
            ),
          ),
        ),
      interrupt: (input) => Queue.offer(interrupts, input).pipe(Effect.asVoid),
    };
    const registry = DriverRegistry.DriverRegistry.of({
      get: () => Effect.succeed(driver),
      register: () => Effect.void,
      remove: () => Effect.void,
    });
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:stop-uncertain", nodeId: "root", task: "Go" });
      yield* Queue.take(calls);
      const stopped = yield* engine.stop("workflow", "run:stop-uncertain");
      const interrupt = yield* Queue.take(interrupts);
      assert.strictEqual(interrupt.runId, undefined);
      assert.strictEqual(stopped.status, "stopped");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("fails a task with the driver's message when the send is certain to have failed", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const driver: NodeDriver = {
      ...harness.driver,
      send: () =>
        Effect.fail(new NodeDriverError({ operation: "send", message: "Re-pair needed: expired" })),
    };
    const registry = DriverRegistry.DriverRegistry.of({
      get: () => Effect.succeed(driver),
      register: () => Effect.void,
      remove: () => Effect.void,
    });
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:expired", nodeId: "root", task: "Go" });
      const event = yield* waitForRun(store, (run) => run.status === "failed");
      if (event.kind === "run.upserted")
        assert.strictEqual(event.run.summary, "Re-pair needed: expired");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("does not start a schedule while a run is active and skips a paused schedule", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = BoardScheduler.layer.pipe(
      Layer.provideMerge(TaskEngine.layer),
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      const dueAt = DateTime.formatIso(yield* DateTime.now);
      const schedule = {
        workflowId: "workflow",
        nodeId: "root",
        task: "Scheduled task",
        everyMs: 60_000,
        nextRunAt: dueAt,
      };
      yield* store.transaction(
        Effect.gen(function* () {
          yield* seed(store, {
            ...setupWorkflow(),
            runs: [
              {
                id: "busy",
                nodeId: "root",
                nodeName: "root",
                task: "Busy",
                status: "running",
                startedAt: dueAt,
                requests: [],
                threads: {},
                definition: definitionOf(),
              },
            ],
          });
          yield* store.putSchedule({ ...schedule, id: "active", enabled: true });
          yield* store.putSchedule({ ...schedule, id: "paused", enabled: false });
        }),
      );
      yield* TestClock.adjust("5 seconds");
      yield* store.events(0).pipe(
        Stream.filter((entry) => entry.kind === "schedule.upserted"),
        Stream.runHead,
      );
      const schedules = yield* store.listSchedules();
      assert.notStrictEqual(schedules.find((entry) => entry.id === "active")?.nextRunAt, dueAt);
      assert.strictEqual(schedules.find((entry) => entry.id === "paused")?.nextRunAt, dueAt);
      assert.strictEqual((yield* store.getWorkflow("workflow"))?.runs.length, 1);
      assert.strictEqual(yield* Queue.size(harness.sends), 0);
    }).pipe(Effect.provide(layer));
  }),
);

const withKanban = (kanban: string, routing: string) =>
  `\`\`\`json\n{"summary":"plan","data":null,"kanban":${kanban},"routing":${routing}}\n\`\`\``;
const requestTo = (to: string) => `{"kind":"request","requests":[{"to":"${to}","task":"work"}]}`;
const card = (id: string, assigneeNodeId: string) => ({
  id,
  title: id,
  body: "",
  status: "todo" as const,
  assigneeNodeId,
  updatedBy: "engine",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

it.effect(
  "accepts several id-less card creates in one reply and tells the orchestrator their ids",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const layer = TaskEngine.layer.pipe(
        Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
        Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      );
      yield* Effect.gen(function* () {
        const engine = yield* TaskEngine.TaskEngine;
        const store = yield* BoardStore.BoardStore;
        yield* store.transaction(seed(store, setupWorkflow()));
        yield* engine.start("workflow", { id: "run:cards", nodeId: "root", task: "Plan" });
        const root = yield* Queue.take(harness.sends);
        yield* harness.reply(
          root,
          withKanban(
            '[{"op":"create","title":"Plan it","assignee":"one"},{"op":"create","title":"Build it","assignee":"two"}]',
            '{"kind":"request","requests":[{"to":"one","task":"first"},{"to":"two","task":"second"}]}',
          ),
        );
        const first = yield* Queue.take(harness.sends);
        const second = yield* Queue.take(harness.sends);
        const cards = yield* store.listKanban("workflow");
        assert.deepStrictEqual(cards.map((entry) => [entry.title, entry.status]).toSorted(), [
          ["Build it", "doing"],
          ["Plan it", "doing"],
        ]);
        yield* harness.reply(first, returned("a"));
        yield* harness.reply(second, returned("b"));
        const joined = yield* Queue.take(harness.sends);
        for (const entry of cards) assert.include(joined.text, entry.id);
        assert.include(joined.text, "Plan it");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("a worker's return completes the card chosen for its own request", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* store.putCard("workflow", card("card-a", "one"));
      yield* store.putCard("workflow", card("card-b", "one"));
      const requestFrom = (runId: string) =>
        Effect.gen(function* () {
          yield* engine.start("workflow", { id: runId, nodeId: "root", task: "Go" });
          const root = yield* Queue.take(harness.sends);
          yield* harness.reply(root, withKanban("[]", requestTo("one")));
          return yield* Queue.take(harness.sends);
        });
      const forA = yield* requestFrom("run:a");
      const forB = yield* requestFrom("run:b");
      const status = () =>
        store
          .listKanban("workflow")
          .pipe(
            Effect.map((cards) => cards.map((entry) => `${entry.id}:${entry.status}`).toSorted()),
          );
      assert.deepStrictEqual(yield* status(), ["card-a:doing", "card-b:doing"]);
      yield* harness.reply(forB, returned("b done"));
      yield* waitForRun(
        store,
        (run) => run.id === "run:b" && run.requests.some((entry) => entry.status === "returned"),
      );
      assert.deepStrictEqual(yield* status(), ["card-a:doing", "card-b:done"]);
      assert.isDefined(forA);
    }).pipe(Effect.provide(layer));
  }),
);
