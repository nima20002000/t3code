import { assert, it } from "@effect/vitest";
import {
  createWorkflow,
  type BoardDriverSend,
  type BoardDriverSettled,
  type NodeDriver,
} from "@t3tools/board-core";
import { EnvironmentId, MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
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

const environmentId = EnvironmentId.make("environment:test");
const projectId = ProjectId.make("project:test");
const thread = (id: string) => ThreadId.make(`thread:${id}`);
const node = (id: string) => ({
  id,
  name: id,
  environmentId,
  projectId,
  threadId: thread(id),
  x: 0,
  y: 0,
  baselined: true,
});
const finish = '```json\n{"summary":"finished","data":42,"routing":{"kind":"finish"}}\n```';
const request =
  '```json\n{"summary":"delegate","data":null,"routing":{"kind":"request","requests":[{"to":"one","task":"first"},{"to":"two","task":"second"}]}}\n```';
const returned = (summary: string) =>
  `\`\`\`json\n{"summary":"${summary}","data":null,"routing":{"kind":"return"}}\n\`\`\``;

const makeHarness = Effect.gen(function* () {
  const sends = yield* Queue.unbounded<BoardDriverSend>();
  const interrupts = yield* Queue.unbounded<ThreadId>();
  const replies = new Map<ThreadId, Queue.Queue<BoardDriverSettled>>();
  for (const id of ["root", "one", "two"])
    replies.set(thread(id), yield* Queue.unbounded<BoardDriverSettled>());
  const messages = yield* Ref.make(new Map<RunId, string>());
  const driver: NodeDriver = {
    launch: () => Effect.die("launch is not used"),
    send: (input) =>
      Queue.offer(sends, input).pipe(
        Effect.as({ runId: RunId.make(input.messageId), sequence: 0 }),
      ),
    subscribeSettled: ({ thread: target }) => Stream.fromQueue(replies.get(target.threadId)!),
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
      yield* Queue.offer(replies.get(sent.thread.threadId)!, {
        thread: sent.thread,
        runId,
        messageId: sent.messageId,
        sequence: 1,
        status,
      });
    });
  return { sends, interrupts, reply, registry, driver };
});

const setupWorkflow = (
  waitPolicy: "allSettled" | "failFast" = "allSettled",
  limit: number | null = null,
) => ({
  ...createWorkflow("workflow", "Workflow"),
  nodes: [node("root"), node("one"), node("two")],
  edges: [
    { a: "root", b: "one" },
    { a: "root", b: "two" },
  ],
  settings: {
    ...createWorkflow("workflow", "Workflow").settings,
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
      yield* store.transaction(store.putWorkflow(setupWorkflow()));
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
      assert.strictEqual(joined.thread.threadId, thread("root"));
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
      yield* store.transaction(store.putWorkflow(setupWorkflow("failFast")));
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
      yield* store.transaction(store.putWorkflow(setupWorkflow()));
      yield* engine.start("workflow", { id: "run:stop", nodeId: "root", task: "Delegate" });
      yield* harness.reply(yield* Queue.take(harness.sends), request);
      yield* Queue.take(harness.sends);
      yield* Queue.take(harness.sends);
      const stopped = yield* engine.stop("workflow", "run:stop");
      assert.strictEqual(stopped.status, "stopped");
      assert.isTrue(
        (yield* store.listTasks("run:stop")).every((task) => task.status === "stopped"),
      );
      const interrupted = [
        yield* Queue.take(harness.interrupts),
        yield* Queue.take(harness.interrupts),
      ];
      assert.deepStrictEqual(new Set(interrupted), new Set([thread("one"), thread("two")]));
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
    yield* store.transaction(store.putWorkflow(setupWorkflow()));
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
      yield* store.transaction(store.putWorkflow(setupWorkflow("allSettled", 0)));
      yield* engine.start("workflow", { id: "run:capped", nodeId: "root", task: "Delegate" });
      yield* harness.reply(yield* Queue.take(harness.sends), request);
      const response = yield* Queue.take(harness.sends);
      assert.strictEqual(response.thread.threadId, thread("root"));
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
    yield* store.transaction(store.putWorkflow(setupWorkflow()));
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
          yield* store.putWorkflow(setupWorkflow());
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
