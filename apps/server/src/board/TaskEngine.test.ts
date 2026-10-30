import { assert, it } from "@effect/vitest";
import {
  createWorkflow,
  NodeDriverError,
  type BoardDriverSend,
  type BoardDriverSettled,
  type BoardNode,
  type BoardNewNodeChatInput,
  type NodeDriver,
} from "@t3tools/board-core";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2PlanStep,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSchedules from "./AgentSchedules.ts";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as TaskEngine from "./TaskEngine.ts";
import * as BoardScheduler from "./BoardScheduler.ts";
import * as BoardService from "./BoardService.ts";
import * as PeerStore from "./remote/PeerStore.ts";

const environmentId = EnvironmentId.make("environment:test");
const italy = {
  id: "italy",
  name: "Italy VPS",
  environmentId,
  url: "https://italy.example",
  bearer: "secret",
};
const retryingOf = (store: BoardStore.BoardStore["Service"], runId: string) =>
  store
    .getWorkflow("workflow")
    .pipe(Effect.map((workflow) => workflow?.runs.find((run) => run.id === runId)?.retrying));
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
const finish =
  '```json\n{"summary":"finished","data":42,"kanban":[{"op":"create","title":"Wrap up","status":"done"}],"routing":{"kind":"finish"}}\n```';
const finishWithoutCards =
  '```json\n{"summary":"finished","data":42,"routing":{"kind":"finish"}}\n```';
const request =
  '```json\n{"summary":"delegate","data":null,"kanban":[{"op":"create","title":"first","assignee":"one"},{"op":"create","title":"second","assignee":"two"}],"routing":{"kind":"request","requests":[{"to":"one","task":"first"},{"to":"two","task":"second"}]}}\n```';
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
  // Whether an agent's own chat in the workspace folder is working on the machine.
  const projectBusy = yield* Ref.make(false);
  const carries = yield* Queue.unbounded<Parameters<NodeDriver["carryBrowserTabs"]>[0]>();
  const liveTodoLists = new Map<ThreadId, Queue.Queue<ReadonlyArray<OrchestrationV2PlanStep>>>();
  const todoLists = yield* Ref.make(new Map<RunId, ReadonlyArray<OrchestrationV2PlanStep>>());
  const driver: NodeDriver = {
    ensureProject: (input) => Queue.offer(projects, input).pipe(Effect.as({ adopted: false })),
    projectBusy: () => Ref.get(projectBusy),
    carryBrowserTabs: (input) => Queue.offer(carries, input).pipe(Effect.asVoid),
    deleteProject: () => Effect.void,
    launch: (input) =>
      Effect.gen(function* () {
        if (!replies.has(input.launch.threadId)) {
          replies.set(input.launch.threadId, yield* Queue.unbounded<BoardDriverSettled>());
          liveTodoLists.set(
            input.launch.threadId,
            yield* Queue.unbounded<ReadonlyArray<OrchestrationV2PlanStep>>(),
          );
        }
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
    subscribePlans: ({ thread: target }) => Stream.fromQueue(liveTodoLists.get(target.threadId)!),
    readPlan: ({ runId }) => Ref.get(todoLists).pipe(Effect.map((all) => all.get(runId) ?? null)),
    readLatestAssistant: ({ runId }) =>
      Ref.get(messages).pipe(
        Effect.map((all) => {
          const text = runId === undefined ? undefined : all.get(runId);
          return text === undefined ? null : { id: MessageId.make(`answer:${runId}`), text };
        }),
      ),
    interrupt: ({ thread: target }) => Queue.offer(interrupts, target.threadId).pipe(Effect.asVoid),
    getScheduledTask: () => Effect.succeed(null),
    upsertScheduledTask: () => Effect.die("no schedules here"),
    setScheduledTaskEnabled: () => Effect.void,
    deleteScheduledTask: () => Effect.void,
  };
  const registry = DriverRegistry.DriverRegistry.of({
    get: () => Effect.succeed(driver),
    register: () => Effect.void,
    remove: () => Effect.void,
  });
  const reply = (
    sent: Pick<BoardDriverSend, "thread" | "messageId">,
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
  /** The agent writes its to-do list while the turn of `sent` runs. */
  const writeTodoList = (
    sent: Pick<BoardDriverSend, "thread" | "messageId">,
    steps: ReadonlyArray<readonly [string, OrchestrationV2PlanStep["status"]]>,
  ) =>
    Effect.gen(function* () {
      const list = steps.map(([text, status], index) => ({ id: `todo-${index}`, text, status }));
      yield* Ref.update(todoLists, (current) =>
        new Map(current).set(RunId.make(sent.messageId), list),
      );
      yield* Queue.offer(liveTodoLists.get(sent.thread.threadId)!, list);
    });
  return {
    writeTodoList,
    sends,
    interrupts,
    launches,
    projects,
    projectBusy,
    carries,
    reply,
    registry,
    driver,
  };
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
  afterSequence = 0,
) =>
  store.events(afterSequence).pipe(
    Stream.filter((event) => event.kind === "run.upserted" && predicate(event.run)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect("schedules outlive a deleted node and go with their workflow", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = BoardService.layer.pipe(
      Layer.provide(AgentSchedules.layer),
      Layer.provideMerge(TaskEngine.layer),
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      for (const id of ["a", "b"]) {
        yield* board.createSchedule({
          id: `schedule:${id}`,
          workflowId: "workflow",
          task: "Work",
          timing: { type: "interval", everyMs: 60_000 },
          enabled: true,
        });
      }
      yield* board.deleteNode("workflow", "one");
      assert.deepStrictEqual(
        (yield* board.listSchedules()).map((entry) => entry.id),
        ["schedule:a", "schedule:b"],
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
        ["schedule:a", "schedule:b"],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("/new hands the agent's browser tabs from its old chat to the new one", () =>
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
      const first = yield* engine.openNodeChat("workflow", "one");
      assert.strictEqual(yield* Queue.size(harness.carries), 0);
      const fresh = yield* engine.openNodeChat("workflow", "one", {});
      assert.deepStrictEqual(yield* Queue.takeAll(harness.carries), [
        { environmentId, from: first.chat?.threadId, to: fresh.chat?.threadId },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("an agent's new run thread takes over the tabs of the chat it showed before", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      const chat = yield* engine.openNodeChat("workflow", "one");
      yield* engine.start("workflow", { id: "run:tabs", task: "Delegate" });
      yield* harness.reply(yield* Queue.take(harness.sends), request);
      const toOne = yield* Queue.take(harness.sends);
      const toTwo = yield* Queue.take(harness.sends);
      const runThreadOfOne = [toOne, toTwo].find(
        (sent) => sent.thread.threadId !== chat.chat?.threadId && sent.text.includes("first"),
      )?.thread.threadId;
      // "two" had no thread before, so only "one" moves its tabs.
      assert.deepStrictEqual(yield* Queue.takeAll(harness.carries), [
        { environmentId, from: chat.chat?.threadId, to: runThreadOfOne },
      ]);
    }).pipe(Effect.provide(engineWith(harness.driver)));
  }),
);

it.effect("opens a node's own chat once, without a run, in the workspace folder", () =>
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
      const opened = yield* engine.openNodeChat("workflow", "one");
      const again = yield* engine.openNodeChat("workflow", "one");
      const launched = yield* Queue.takeAll(harness.launches);
      assert.strictEqual(launched.length, 1);
      assert.strictEqual(launched[0]!.launch.threadId, opened.chat?.threadId);
      assert.deepStrictEqual(again.chat, opened.chat);
      const workflow = yield* store.getWorkflow("workflow");
      assert.deepStrictEqual(
        workflow?.nodes.find((entry) => entry.id === "one")?.chat,
        opened.chat,
      );
      assert.deepStrictEqual(workflow?.runs, []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "/new moves a node's chat to a fresh thread with the same settings, which later opens keep",
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
        const opened = yield* engine.openNodeChat("workflow", "one");
        // The chat was switched to another model and to plan mode before "/new".
        const current: BoardNewNodeChatInput = {
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-opus-5-5",
          },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        };
        const fresh = yield* engine.openNodeChat("workflow", "one", current);
        const again = yield* engine.openNodeChat("workflow", "one");
        const [first, second, ...rest] = yield* Queue.takeAll(harness.launches);
        assert.deepStrictEqual(rest, []);
        assert.notStrictEqual(fresh.chat?.threadId, opened.chat?.threadId);
        assert.strictEqual(second!.launch.threadId, fresh.chat?.threadId);
        assert.strictEqual(second!.launch.projectId, first!.launch.projectId);
        assert.deepStrictEqual(
          {
            modelSelection: second!.launch.modelSelection,
            runtimeMode: second!.launch.runtimeMode,
            interactionMode: second!.launch.interactionMode,
          },
          current,
        );
        assert.deepStrictEqual(again.chat, fresh.chat);
        const workflow = yield* store.getWorkflow("workflow");
        assert.deepStrictEqual(
          workflow?.nodes.find((entry) => entry.id === "one")?.chat,
          fresh.chat,
        );
      }).pipe(Effect.provide(layer));
    }),
);

/** An engine whose first chat launch waits until released, so a test can act in between. */
const withHeldLaunch = <A, E>(
  body: (held: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  }) => Effect.Effect<A, E, TaskEngine.TaskEngine | BoardStore.BoardStore | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let held = false;
    const driver: NodeDriver = {
      ...harness.driver,
      launch: (input) => {
        if (held) return harness.driver.launch(input);
        held = true;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(harness.driver.launch(input)),
        );
      },
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
    return yield* Effect.scoped(body({ entered, release }).pipe(Effect.provide(layer)));
  });

it.effect("a first open that finishes after /new does not bring the old chat back", () =>
  withHeldLaunch(({ entered, release }) =>
    Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      const slow = yield* Effect.forkScoped(engine.openNodeChat("workflow", "one"));
      yield* Deferred.await(entered);
      const fresh = yield* engine.openNodeChat("workflow", "one", {});
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual((yield* Fiber.join(slow)).chat, fresh.chat);
      const workflow = yield* store.getWorkflow("workflow");
      assert.deepStrictEqual(workflow?.nodes.find((entry) => entry.id === "one")?.chat, fresh.chat);
    }),
  ),
);

it.effect("/new does not give a node a chat on the machine it left while the chat started", () =>
  withHeldLaunch(({ entered, release }) =>
    Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      const workflow = setupWorkflow();
      yield* store.transaction(seed(store, workflow));
      const starting = yield* Effect.forkScoped(engine.openNodeChat("workflow", "one", {}));
      yield* Deferred.await(entered);
      const elsewhere = EnvironmentId.make("other-machine");
      yield* store.transaction(
        store.putWorkflow({
          ...workflow,
          nodes: workflow.nodes.map((entry) =>
            entry.id === "one" ? { ...entry, environmentId: elsewhere } : entry,
          ),
        }),
      );
      yield* Deferred.succeed(release, undefined);
      const result = yield* Effect.exit(Fiber.join(starting));
      assert.isTrue(result._tag === "Failure");
      const saved = yield* store.getWorkflow("workflow");
      const node = saved?.nodes.find((entry) => entry.id === "one");
      assert.strictEqual(node?.environmentId, elsewhere);
      assert.strictEqual(node?.chat, undefined);
    }),
  ),
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
      yield* engine.start("workflow", { id: "run:join", task: "Delegate" });
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
      yield* engine.start("workflow", { id: "run:fail-fast", task: "Delegate" });
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
      yield* engine.start("workflow", { id: "run:join-race", task: "Delegate" });
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
      yield* engine.start("workflow", { id: "run:stop", task: "Delegate" });
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
        yield* engine.start("workflow", { id: "run:stop-recovery", task: "Hold" });
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
      yield* engine.start("workflow", { id: "run:stop-retry", task: "Hold" });
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
      yield* engine.start("workflow", { id: "run:capped", task: "Delegate" });
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
        yield* engine.start("workflow", { id: "run:recovery", task: "Recover" });
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
            task: "Scheduled task",
            timing: { type: "interval", everyMs: 60_000 },
            runCount: 0,
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

it.effect("a workflow schedule with a run limit stops after its last run", () =>
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
            id: "limited",
            workflowId: "workflow",
            task: "Last task",
            timing: { type: "interval", everyMs: 60_000 },
            maxRuns: 2,
            runCount: 1,
            enabled: true,
            nextRunAt: DateTime.formatIso(yield* DateTime.now),
          });
        }),
      );
      yield* TestClock.adjust("5 seconds");
      const sent = yield* Queue.take(harness.sends);
      assert.include(sent.text, "Last task");
      const [schedule] = yield* store.listSchedules();
      assert.deepInclude(schedule, { runCount: 2, enabled: false, nextRunAt: null });
      yield* harness.reply(sent, finish);
    }).pipe(Effect.provide(layer));
  }),
);

const schedulerLayer = (harness: Effect.Success<typeof makeHarness>) =>
  BoardScheduler.layer.pipe(
    Layer.provideMerge(TaskEngine.layer),
    Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
    Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  );

it.effect("a due workflow schedule waits while an agent works in the workspace, then runs", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(
        Effect.gen(function* () {
          yield* store.putWorkspace({
            ...workspace,
            folders: [
              {
                environmentId,
                projectId: ProjectId.make("project:workspace"),
                path: "/work",
                managed: true,
              },
            ],
          });
          yield* store.putWorkflow(setupWorkflow());
          yield* store.putSchedule({
            id: "daily",
            workflowId: "workflow",
            task: "Held task",
            timing: { type: "fixed_time", timeOfDay: "00:00" },
            runCount: 0,
            enabled: true,
            nextRunAt: DateTime.formatIso(yield* DateTime.now),
          });
        }),
      );
      yield* Ref.set(harness.projectBusy, true);
      // Long past the grace a missed time-of-day run gets: held, not missed.
      yield* TestClock.adjust("20 minutes");
      assert.isTrue(Option.isNone(yield* Queue.poll(harness.sends)));
      assert.strictEqual((yield* store.listSchedules())[0]?.runCount, 0);
      yield* Ref.set(harness.projectBusy, false);
      yield* TestClock.adjust("5 seconds");
      const sent = yield* Queue.take(harness.sends);
      assert.include(sent.text, "Held task");
      assert.strictEqual((yield* store.listSchedules())[0]?.runCount, 1);
      yield* harness.reply(sent, finish);
    }).pipe(Effect.provide(schedulerLayer(harness)));
  }),
);

it.effect("a schedule that continues its chats compacts them after each run and reuses them", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(
        Effect.gen(function* () {
          yield* seed(store, setupWorkflow());
          yield* store.putSchedule({
            id: "continued",
            workflowId: "workflow",
            task: "Continue task",
            timing: { type: "interval", everyMs: 60_000 },
            runCount: 0,
            enabled: true,
            chats: "continue",
            nextRunAt: DateTime.formatIso(yield* DateTime.now),
          });
        }),
      );
      yield* TestClock.adjust("5 seconds");
      const first = yield* Queue.take(harness.sends);
      yield* harness.reply(first, finish);
      const compact = yield* Queue.take(harness.sends);
      assert.strictEqual(compact.text, "/compact");
      assert.strictEqual(compact.thread.threadId, first.thread.threadId);
      yield* TestClock.adjust("60 seconds");
      const second = yield* Queue.take(harness.sends);
      assert.include(second.text, "Continue task");
      assert.strictEqual(second.thread.threadId, first.thread.threadId);
      assert.lengthOf(yield* Queue.takeAll(harness.launches), 1);
      // The same chat keeps its own tabs; nothing moves.
      assert.strictEqual(yield* Queue.size(harness.carries), 0);
      yield* harness.reply(second, finish);
    }).pipe(Effect.provide(schedulerLayer(harness)));
  }),
);

it.effect("a schedule with new chats starts each run in a fresh chat and compacts nothing", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(
        Effect.gen(function* () {
          yield* seed(store, setupWorkflow());
          yield* store.putSchedule({
            id: "fresh",
            workflowId: "workflow",
            task: "Fresh task",
            timing: { type: "interval", everyMs: 60_000 },
            runCount: 0,
            enabled: true,
            nextRunAt: DateTime.formatIso(yield* DateTime.now),
          });
        }),
      );
      yield* TestClock.adjust("5 seconds");
      const first = yield* Queue.take(harness.sends);
      yield* harness.reply(first, finish);
      yield* TestClock.adjust("60 seconds");
      const second = yield* Queue.take(harness.sends);
      assert.include(second.text, "Fresh task");
      assert.notStrictEqual(second.thread.threadId, first.thread.threadId);
      // The agent keeps the browser its last run's chat used.
      assert.deepStrictEqual(yield* Queue.takeAll(harness.carries), [
        { environmentId, from: first.thread.threadId, to: second.thread.threadId },
      ]);
      yield* harness.reply(second, finish);
    }).pipe(Effect.provide(schedulerLayer(harness)));
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
      yield* engine.start("workflow", { id: "run:bg-stop", task: "Hold" });
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
      yield* engine.start("workflow", { id: "run:a", task: "A" });
      yield* Queue.take(harness.sends);
      yield* engine.start("workflow", { id: "run:b", task: "B" });
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
      const input = { id: "run:again", task: "Once" };
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
      yield* engine.start("workflow", { id: "run:new", task: "New" });
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
      yield* store.putPeer(italy);
      yield* engine.start("workflow", { id: "run:uncertain", task: "Go" });
      const first = yield* Queue.take(calls);
      // Every viewer sees the machine is being retried, and why.
      const retrying = yield* waitForRun(store, (run) => run.retrying !== undefined);
      if (retrying.kind === "run.upserted")
        assert.deepStrictEqual(retrying.run.retrying, {
          root: "Italy VPS can't be reached, retrying every 15 s",
        });
      yield* TestClock.adjust("15 seconds");
      const second = yield* Queue.take(calls);
      assert.strictEqual(second.commandId, first.commandId);
      assert.strictEqual(second.messageId, first.messageId);
      yield* waitForRun(store, (run) => run.threads.root?.seeded === true);
      assert.strictEqual((yield* store.getTask("run:uncertain"))?.status, "running");
      assert.strictEqual(yield* retryingOf(store, "run:uncertain"), undefined);
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
      yield* engine.start("workflow", { id: "run:stop-uncertain", task: "Go" });
      yield* Queue.take(calls);
      yield* waitForRun(store, (run) => run.retrying !== undefined);
      const stopped = yield* engine.stop("workflow", "run:stop-uncertain");
      const interrupt = yield* Queue.take(interrupts);
      assert.strictEqual(interrupt.runId, undefined);
      assert.strictEqual(stopped.status, "stopped");
      assert.strictEqual(stopped.retrying, undefined);
      assert.strictEqual(yield* retryingOf(store, "run:stop-uncertain"), undefined);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("shows a turn's machine as retried while it cannot be reached, until it is back", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = TaskEngine.layer.pipe(
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, harness.registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      const peers = PeerStore.makeBoard(store);
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* store.putPeer(italy);
      yield* engine.start("workflow", { id: "run:settle", task: "Go" });
      const sent = yield* Queue.take(harness.sends);
      const seeded = yield* waitForRun(store, (run) => run.threads.root?.seeded === true);
      yield* peers.setStatus!(italy, "error", "Could not reach or authenticate this machine.");
      const lost = yield* waitForRun(store, (run) => run.retrying !== undefined, seeded.sequence);
      if (lost.kind === "run.upserted")
        assert.deepStrictEqual(lost.run.retrying, {
          root: "Italy VPS can't be reached, reconnecting",
        });
      yield* peers.setStatus!(italy, "connected");
      yield* waitForRun(store, (run) => run.retrying === undefined, lost.sequence);
      yield* harness.reply(sent, finish);
      const finished = yield* waitForRun(store, (run) => run.status === "finished");
      if (finished.kind === "run.upserted") assert.strictEqual(finished.run.retrying, undefined);
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
      yield* engine.start("workflow", { id: "run:expired", task: "Go" });
      const event = yield* waitForRun(store, (run) => run.status === "failed");
      if (event.kind === "run.upserted")
        assert.strictEqual(event.run.summary, "Re-pair needed: expired");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a due schedule waits while a run is active and a paused one never starts", () =>
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
        timing: { type: "interval" as const, everyMs: 60_000 },
        runCount: 0,
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
      const schedules = yield* store.listSchedules();
      // Still due: it starts once the run is over instead of losing this firing.
      assert.strictEqual(schedules.find((entry) => entry.id === "active")?.nextRunAt, dueAt);
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
        yield* engine.start("workflow", { id: "run:cards", task: "Plan" });
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
          yield* engine.start("workflow", { id: runId, task: "Go" });
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

const waitForCards = (
  store: BoardStore.BoardStore["Service"],
  predicate: (cards: ReadonlyArray<import("@t3tools/board-core").KanbanCard>) => boolean,
) =>
  store.events(0).pipe(
    Stream.mapEffect(() => store.listKanban("workflow")),
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect("an orchestrator working alone fills the kanban live from its to-do list", () =>
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
      yield* store.putCard("workflow", { ...card("by-hand", "root"), status: "done" });
      yield* engine.start("workflow", { id: "run:alone", task: "Fix the bug" });
      const root = yield* Queue.take(harness.sends);
      yield* harness.writeTodoList(root, [
        ["Read the code", "running"],
        ["Fix the bug", "pending"],
      ]);
      const shown = (cards: ReadonlyArray<import("@t3tools/board-core").KanbanCard>) =>
        cards
          .map((entry) => [entry.title, entry.status, entry.assigneeNodeId, entry.runId])
          .toSorted();
      // The cards appear while the orchestrator is still working, before it replies.
      assert.deepStrictEqual(shown(yield* waitForCards(store, (cards) => cards.length === 3)), [
        ["Fix the bug", "todo", "root", "run:alone"],
        ["Read the code", "doing", "root", "run:alone"],
        ["by-hand", "done", "root", undefined],
      ]);
      yield* harness.writeTodoList(root, [
        ["Read the code", "completed"],
        ["Fix the bug", "completed"],
      ]);
      yield* harness.reply(root, finishWithoutCards);
      yield* waitForRun(store, (run) => run.id === "run:alone" && run.status === "finished");
      assert.deepStrictEqual(shown(yield* store.listKanban("workflow")), [
        ["Fix the bug", "done", "root", "run:alone"],
        ["Read the code", "done", "root", "run:alone"],
        ["by-hand", "done", "root", undefined],
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a run that would finish with no card of its own is sent back to add one", () =>
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
      yield* engine.start("workflow", { id: "run:bare", task: "Answer" });
      yield* harness.reply(yield* Queue.take(harness.sends), finishWithoutCards);
      const correction = yield* Queue.take(harness.sends);
      assert.include(correction.text, "this run has no cards");
      yield* harness.reply(correction, finish);
      yield* waitForRun(store, (entry) => entry.id === "run:bare" && entry.status === "finished");
    }).pipe(Effect.provide(layer));
  }),
);

const engineWith = (driver: NodeDriver) =>
  TaskEngine.layer.pipe(
    Layer.provide(
      Layer.succeed(
        DriverRegistry.DriverRegistry,
        DriverRegistry.DriverRegistry.of({
          get: () => Effect.succeed(driver),
          register: () => Effect.void,
          remove: () => Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  );

it.effect("fails a cut turn its machine did not continue, sending nothing itself", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:cut", task: "Go" });
      yield* harness.reply(yield* Queue.take(harness.sends), "", "cancelled");
      const event = yield* waitForRun(store, (run) => run.status !== "running");
      if (event.kind === "run.upserted") {
        assert.strictEqual(event.run.status, "failed");
        assert.strictEqual(event.run.summary, "The thread cancelled.");
      }
      assert.strictEqual(yield* Queue.size(harness.sends), 0);
    }).pipe(Effect.provide(engineWith(harness.driver)));
  }),
);

it.effect("a hub restart keeps waiting on the turn and finishes it from the reopened store", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
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
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "board-hub-restart-" });
    // Each hub run opens the board database from disk, as a restarted server does.
    const hub = TaskEngine.layer.pipe(
      Layer.provide(
        Layer.succeed(
          DriverRegistry.DriverRegistry,
          DriverRegistry.DriverRegistry.of({
            get: () => Effect.succeed(driver),
            register: () => Effect.void,
            remove: () => Effect.void,
          }),
        ),
      ),
      Layer.provideMerge(
        BoardStore.layer.pipe(
          Layer.provide(SqlitePersistence.layerFromPath(`${directory}/state.sqlite`)),
        ),
      ),
    );
    const root = yield* Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* TaskEngine.TaskEngine;
        const store = yield* BoardStore.BoardStore;
        yield* store.transaction(seed(store, setupWorkflow()));
        yield* engine.start("workflow", { id: "run:hub-restart", task: "Go" });
        const root = yield* Queue.take(harness.sends);
        yield* Queue.take(subscribed);
        return root;
      }).pipe(Effect.provide(hub)),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* BoardStore.BoardStore;
        yield* Queue.take(subscribed);
        yield* harness.reply(root, finish);
        yield* waitForRun(store, (run) => run.status === "finished");
        assert.strictEqual(yield* Queue.size(harness.sends), 0);
      }).pipe(Effect.provide(hub)),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("Stop moves the stopped work's cards out of doing", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:stop-cards", task: "Delegate" });
      yield* harness.reply(yield* Queue.take(harness.sends), request);
      yield* Queue.take(harness.sends);
      yield* Queue.take(harness.sends);
      const doing = (yield* store.listKanban("workflow")).map((card) => card.status);
      assert.deepStrictEqual(doing, ["doing", "doing"]);
      yield* engine.stop("workflow", "run:stop-cards");
      assert.deepStrictEqual(
        (yield* store.listKanban("workflow")).map((card) => [card.status, card.reason]),
        [
          ["blocked", "Stopped by user."],
          ["blocked", "Stopped by user."],
        ],
      );
    }).pipe(Effect.provide(engineWith(harness.driver)));
  }),
);

it.effect("Stop moves the run's cards still in todo to blocked", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:stop-todo", task: "Delegate" });
      yield* harness.reply(
        yield* Queue.take(harness.sends),
        request.replace('"kanban":[', '"kanban":[{"op":"create","title":"later"},'),
      );
      yield* Queue.take(harness.sends);
      yield* Queue.take(harness.sends);
      yield* engine.stop("workflow", "run:stop-todo");
      const cards = yield* store.listKanban("workflow");
      assert.deepStrictEqual(
        cards.map((card) => [card.title, card.status]),
        [
          ["later", "blocked"],
          ["first", "blocked"],
          ["second", "blocked"],
        ],
      );
      assert.strictEqual(cards.find((card) => card.title === "later")?.reason, "Stopped by user.");
    }).pipe(Effect.provide(engineWith(harness.driver)));
  }),
);

it.effect("finishes a Stop within seconds once the agent's machine is back", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const calls = yield* Queue.unbounded<Parameters<NodeDriver["interrupt"]>[0]>();
    const away = yield* Ref.make(true);
    const driver: NodeDriver = {
      ...harness.driver,
      interrupt: (input) =>
        Queue.offer(calls, input).pipe(
          Effect.andThen(Ref.get(away)),
          Effect.flatMap((isAway) =>
            isAway
              ? Effect.fail(
                  new NodeDriverError({ operation: "interrupt", message: "Away", retryable: true }),
                )
              : Effect.void,
          ),
        ),
    };
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:stop-away", task: "Go" });
      const root = yield* Queue.take(harness.sends);
      const stopping = yield* engine.stop("workflow", "run:stop-away");
      assert.strictEqual(stopping.status, "stopping");
      yield* Queue.take(calls);
      // Stopping again while the machine is still away keeps the run stopping without an error.
      assert.strictEqual((yield* engine.stop("workflow", "run:stop-away")).status, "stopping");
      yield* Queue.takeAll(calls);
      yield* Ref.set(away, false);
      yield* TestClock.adjust("2 seconds");
      const retried = yield* Queue.take(calls);
      assert.strictEqual(retried.thread.threadId, root.thread.threadId);
      yield* waitForRun(store, (run) => run.status === "stopped");
    }).pipe(Effect.provide(engineWith(driver)));
  }),
);

it.effect("retries a Stop within seconds even while the task waits to resend", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const sends = yield* Queue.unbounded<BoardDriverSend>();
    const calls = yield* Queue.unbounded<Parameters<NodeDriver["interrupt"]>[0]>();
    const away = yield* Ref.make(true);
    const lost = new NodeDriverError({ operation: "send", message: "Away", retryable: true });
    const driver: NodeDriver = {
      ...harness.driver,
      send: (input) => Queue.offer(sends, input).pipe(Effect.andThen(Effect.fail(lost))),
      interrupt: (input) =>
        Queue.offer(calls, input).pipe(
          Effect.andThen(Ref.get(away)),
          Effect.flatMap((isAway) =>
            isAway
              ? Effect.fail(
                  new NodeDriverError({ operation: "interrupt", message: "Away", retryable: true }),
                )
              : Effect.void,
          ),
        ),
    };
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:stop-resend", task: "Go" });
      yield* Queue.take(sends);
      assert.strictEqual((yield* engine.stop("workflow", "run:stop-resend")).status, "stopping");
      yield* Queue.take(calls);
      yield* Ref.set(away, false);
      yield* TestClock.adjust("2 seconds");
      yield* Queue.take(calls);
      yield* waitForRun(store, (run) => run.status === "stopped");
    }).pipe(Effect.provide(engineWith(driver)));
  }),
);

it.effect("Stop leaves a card alone once it was handed to another agent", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const engine = yield* TaskEngine.TaskEngine;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(seed(store, setupWorkflow()));
      yield* engine.start("workflow", { id: "run:handed", task: "Delegate" });
      yield* harness.reply(yield* Queue.take(harness.sends), request);
      yield* Queue.take(harness.sends);
      yield* Queue.take(harness.sends);
      const [first, second] = yield* store.listKanban("workflow");
      yield* store.transaction(
        store.putCard("workflow", { ...first!, assigneeNodeId: "someone-else" }),
      );
      yield* engine.stop("workflow", "run:handed");
      const cards = yield* store.listKanban("workflow");
      assert.strictEqual(cards.find((card) => card.id === first!.id)?.status, "doing");
      assert.strictEqual(cards.find((card) => card.id === second!.id)?.status, "blocked");
    }).pipe(Effect.provide(engineWith(harness.driver)));
  }),
);
