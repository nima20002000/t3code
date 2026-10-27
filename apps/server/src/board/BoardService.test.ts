import { assert, it } from "@effect/vitest";
import {
  createWorkflow,
  NodeDriverError,
  type BoardDriverLaunch,
  type BoardDriverSend,
  type NodeDriver,
} from "@t3tools/board-core";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardService from "./BoardService.ts";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as TaskEngine from "./TaskEngine.ts";

const environmentId = EnvironmentId.make("environment:test");
const projectId = ProjectId.make("project:test");
const node = (id: string) => ({
  id,
  name: id,
  environmentId,
  projectId,
  threadId: ThreadId.make(`thread:${id}`),
  x: 0,
  y: 0,
  baselined: true,
});

const makeLayer = (overrides: (sends: Ref.Ref<BoardDriverSend[]>) => Partial<NodeDriver>) =>
  Effect.gen(function* () {
    const sends = yield* Ref.make<BoardDriverSend[]>([]);
    const driver: NodeDriver = {
      launch: (input) =>
        Effect.succeed({
          environmentId,
          projectId: input.launch.projectId,
          threadId: input.launch.threadId,
        }),
      send: (input) =>
        Ref.update(sends, (all) => [...all, input]).pipe(
          Effect.as({ runId: RunId.make(input.messageId), sequence: 0 }),
        ),
      subscribeSettled: () => Stream.empty,
      readLatestAssistant: () => Effect.succeed(null),
      interrupt: () => Effect.void,
      ...overrides(sends),
    };
    const registry = DriverRegistry.DriverRegistry.of({
      get: () => Effect.succeed(driver),
      register: () => Effect.void,
      remove: () => Effect.void,
    });
    const layer = BoardService.layer.pipe(
      Layer.provideMerge(TaskEngine.layer),
      Layer.provide(Layer.succeed(DriverRegistry.DriverRegistry, registry)),
      Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    return { sends, layer };
  });

const briefedNodes = (sends: ReadonlyArray<BoardDriverSend>) =>
  sends.map((send) => send.thread.threadId.replace("thread:", "")).toSorted();

it.effect("rename briefs the node and its neighbors, delete briefs the survivors", () =>
  Effect.gen(function* () {
    const { sends, layer } = yield* makeLayer(() => ({}));
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(
        store.putWorkflow({
          ...createWorkflow("workflow", "Workflow"),
          nodes: [node("a"), node("b"), node("c"), node("d")],
          edges: [
            { a: "a", b: "b" },
            { a: "c", b: "b" },
          ],
        }),
      );
      yield* board.updateNode("workflow", "b", { name: "Renamed" });
      assert.deepStrictEqual(briefedNodes(yield* Ref.get(sends)), ["a", "b", "c"]);
      assert.include(
        (yield* Ref.get(sends)).find((s) => s.thread.threadId === "thread:a")!.text,
        "Renamed",
      );
      yield* Ref.set(sends, []);
      yield* board.deleteNode("workflow", "b");
      assert.deepStrictEqual(briefedNodes(yield* Ref.get(sends)), ["a", "c"]);
      assert.deepStrictEqual(yield* store.listBriefings(), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps a failed briefing pending and delivers it on the next change", () =>
  Effect.gen(function* () {
    const failing = yield* Ref.make(true);
    const { sends, layer } = yield* makeLayer((sent) => ({
      send: (input) =>
        Ref.get(failing).pipe(
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(new NodeDriverError({ operation: "send", message: "Unavailable" }))
              : Ref.update(sent, (all) => [...all, input]).pipe(
                  Effect.as({ runId: RunId.make(input.messageId), sequence: 0 }),
                ),
          ),
        ),
    }));
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(
        store.putWorkflow({
          ...createWorkflow("workflow", "Workflow"),
          nodes: [node("a"), node("b"), node("c")],
        }),
      );
      yield* board.createEdge("workflow", { a: "a", b: "b" });
      assert.strictEqual((yield* store.listBriefings()).length, 2);
      yield* Ref.set(failing, false);
      yield* board.createEdge("workflow", { a: "b", b: "c" });
      assert.deepStrictEqual(yield* store.listBriefings(), []);
      assert.deepStrictEqual(briefedNodes(yield* Ref.get(sends)), ["a", "b", "c"]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a retried Add agent reuses the persisted thread id", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<BoardDriverLaunch[]>([]);
    const failing = yield* Ref.make(true);
    const { layer } = yield* makeLayer(() => ({
      launch: (input) =>
        Ref.update(launches, (all) => [...all, input]).pipe(
          Effect.andThen(Ref.get(failing)),
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(new NodeDriverError({ operation: "launch", message: "Lost" }))
              : Effect.succeed({
                  environmentId,
                  projectId: input.launch.projectId,
                  threadId: input.launch.threadId,
                }),
          ),
        ),
    }));
    yield* Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const store = yield* BoardStore.BoardStore;
      yield* store.transaction(store.putWorkflow(createWorkflow("workflow", "Workflow")));
      const base = {
        kind: "launch" as const,
        id: "agent",
        name: "Agent",
        environmentId,
        projectId,
        modelSelection: { instanceId: "codex", model: "m" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { kind: "project-root" },
        x: 0,
        y: 0,
      } as unknown as Parameters<typeof board.createNode>[1];
      yield* board
        .createNode("workflow", { ...base, threadId: ThreadId.make("thread:first") } as never)
        .pipe(Effect.flip);
      yield* Ref.set(failing, false);
      const created = yield* board.createNode("workflow", {
        ...base,
        threadId: ThreadId.make("thread:second"),
      } as never);
      assert.strictEqual(created.threadId, "thread:first");
      assert.deepStrictEqual(
        (yield* Ref.get(launches)).map((entry) => entry.launch.threadId),
        ["thread:first", "thread:first"],
      );
      assert.strictEqual(yield* store.getLaunchIntent("workflow", "agent"), undefined);
    }).pipe(Effect.provide(layer));
  }),
);
