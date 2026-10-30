// @effect-diagnostics nodeBuiltinImport:off -- the fake machines hash what they store.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  createWorkflow,
  type BoardEvent,
  type BoardNode,
  type NodeDriver,
  type Workflow,
} from "@t3tools/board-core";
import { EnvironmentId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as FileShipper from "./FileShipper.ts";
import * as TaskEngine from "./TaskEngine.ts";
import * as WorkspaceFiles from "./WorkspaceFiles.ts";

const hub = EnvironmentId.make("environment:hub");
const laptop = EnvironmentId.make("environment:laptop");
const vps = EnvironmentId.make("environment:vps");

const agent = (id: string, environmentId: EnvironmentId): BoardNode => ({
  id,
  name: id,
  profile: "orchestrator",
  environmentId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  x: 0,
  y: 0,
});
const workflowWith = (
  id: string,
  workspaceId: string,
  nodes: ReadonlyArray<BoardNode>,
): Workflow => ({
  ...createWorkflow(id, id, workspaceId),
  nodes,
});

/** Each fake machine's shared-files folder, and every copy the hub sent there. */
const makeMachines = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const disks = new Map<EnvironmentId, Map<string, string>>();
  const sent = yield* Queue.unbounded<{ readonly machine: EnvironmentId; readonly name: string }>();
  const offline = new Set<EnvironmentId>();
  /** Machines that store what they are sent but whose answer never reaches the hub. */
  const silent = new Set<EnvironmentId>();
  const gates = new Map<EnvironmentId, Deferred.Deferred<void>>();
  const disk = (machine: EnvironmentId) => {
    const existing = disks.get(machine);
    if (existing) return existing;
    const created = new Map<string, string>();
    disks.set(machine, created);
    return created;
  };
  const reach = (machine: EnvironmentId) =>
    Effect.gen(function* () {
      const gate = gates.get(machine);
      if (gate) yield* Deferred.await(gate);
      if (offline.has(machine))
        return yield* new FileShipper.ShipError({ message: "Laptop is offline." });
    });
  const shipper = FileShipper.FileShipper.of({
    put: (input) =>
      Effect.gen(function* () {
        yield* reach(input.environmentId);
        const content = yield* fs.readFileString(input.source).pipe(Effect.orDie);
        disk(input.environmentId).set(input.name, content);
        yield* Queue.offer(sent, { machine: input.environmentId, name: input.name });
        if (silent.has(input.environmentId))
          return yield* new FileShipper.ShipError({ message: "The connection dropped." });
        return NodeCrypto.createHash("sha256").update(content).digest("hex");
      }),
    remove: (input) =>
      reach(input.environmentId).pipe(
        Effect.andThen(Effect.sync(() => disk(input.environmentId).delete(input.name))),
      ),
  });
  const files = (machine: EnvironmentId) => Object.fromEntries(disk(machine));
  return { shipper, sent, offline, silent, gates, files };
});

const driver: NodeDriver = {
  ensureProject: () => Effect.succeed({ adopted: false }),
  projectBusy: () => Effect.succeed(false),
  carryBrowserTabs: () => Effect.void,
  deleteProject: () => Effect.void,
  launch: (input) =>
    Effect.succeed({
      environmentId: input.environmentId,
      projectId: input.launch.projectId,
      threadId: input.launch.threadId,
    }),
  send: (input) => Effect.succeed({ runId: RunId.make(input.messageId), sequence: 0 }),
  subscribeSettled: () => Stream.never,
  readLatestAssistant: () => Effect.succeed(null),
  interrupt: () => Effect.void,
  getScheduledTask: () => Effect.succeed(null),
  upsertScheduledTask: () => Effect.die("no schedules here"),
  setScheduledTaskEnabled: () => Effect.void,
  deleteScheduledTask: () => Effect.void,
};

const harness = (
  machines: Effect.Success<typeof makeMachines>,
  options?: { driver?: NodeDriver },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const board = yield* Layer.build(
      TaskEngine.layer.pipe(
        Layer.provide(
          Layer.succeed(
            DriverRegistry.DriverRegistry,
            DriverRegistry.DriverRegistry.of({
              get: () => Effect.succeed(options?.driver ?? driver),
              register: () => Effect.void,
              remove: () => Effect.void,
            }),
          ),
        ),
        Layer.provideMerge(BoardStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      ),
    );
    return yield* Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      const engine = yield* TaskEngine.TaskEngine;
      const files = yield* WorkspaceFiles.make({ hubEnvironmentId: hub, root }).pipe(
        Effect.provideService(FileShipper.FileShipper, machines.shipper),
      );
      return { store, engine, files };
    }).pipe(Effect.provideContext(board));
  });

const text = (value: string) => Stream.make(new TextEncoder().encode(value));

type FilesEvent = Extract<BoardEvent, { readonly kind: "workspace.files" }>;
/** The first file state of the workspace after `sequence` that `done` accepts. */
const reached = (
  store: BoardStore.BoardStore["Service"],
  sequence: number,
  workspaceId: string,
  done: (event: FilesEvent) => boolean,
) =>
  store.events(sequence).pipe(
    Stream.filter(
      (event): event is FilesEvent =>
        event.kind === "workspace.files" && event.workspaceId === workspaceId && done(event),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
const allSynced = (event: FilesEvent) =>
  event.files.length > 0 &&
  event.machines.length > 0 &&
  event.machines.every((machine) => machine.status === "synced");
const sequenceOf = (store: BoardStore.BoardStore["Service"]) =>
  store.snapshot().pipe(Effect.map((snapshot) => snapshot.sequence));

const saveWorkflow = (store: BoardStore.BoardStore["Service"], workflow: Workflow) =>
  store.transaction(
    Effect.gen(function* () {
      yield* store.putWorkflow(workflow);
      yield* store.appendEvent({ kind: "workflow.upserted", workflow });
    }),
  );
const seedWorkspace = (
  store: BoardStore.BoardStore["Service"],
  id: string,
  workflows: ReadonlyArray<Workflow>,
) =>
  store.transaction(
    Effect.gen(function* () {
      yield* store.putWorkspace({ id, name: id, folders: [] });
      for (const workflow of workflows) yield* store.putWorkflow(workflow);
    }),
  );

it.effect(
  "each machine of the workspace gets the files, and later only the ones that changed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machines = yield* makeMachines;
        const { store, files } = yield* harness(machines);
        yield* seedWorkspace(store, "research", [
          workflowWith("flow", "research", [agent("writer", laptop)]),
        ]);
        let from = yield* sequenceOf(store);
        yield* files.add("research", "notes.txt", text("v1"));
        yield* files.add("research", "brief.pdf", text("%PDF"));
        yield* reached(
          store,
          from,
          "research",
          (event) => event.files.length === 2 && allSynced(event),
        );
        assert.deepStrictEqual(machines.files(hub), { "notes.txt": "v1", "brief.pdf": "%PDF" });
        assert.deepStrictEqual(machines.files(laptop), { "notes.txt": "v1", "brief.pdf": "%PDF" });
        yield* Queue.takeAll(machines.sent);

        from = yield* sequenceOf(store);
        yield* files.add("research", "notes.txt", text("v2"));
        yield* files.add("research", "brief.pdf", text("%PDF"));
        yield* reached(
          store,
          from,
          "research",
          (event) =>
            allSynced(event) && event.files.find((file) => file.name === "notes.txt")?.size === 2,
        );
        assert.deepStrictEqual(machines.files(laptop), { "notes.txt": "v2", "brief.pdf": "%PDF" });
        assert.deepStrictEqual(
          (yield* Queue.takeAll(machines.sent)).map((entry) => entry.name),
          ["notes.txt", "notes.txt"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a file removed on the hub disappears from every machine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const machines = yield* makeMachines;
      const { store, files } = yield* harness(machines);
      yield* seedWorkspace(store, "research", [
        workflowWith("flow", "research", [agent("writer", laptop)]),
      ]);
      let from = yield* sequenceOf(store);
      yield* files.add("research", "old.txt", text("old"));
      yield* files.add("research", "keep.txt", text("keep"));
      yield* reached(
        store,
        from,
        "research",
        (event) => event.files.length === 2 && allSynced(event),
      );
      from = yield* sequenceOf(store);
      yield* files.remove("research", "old.txt");
      yield* reached(
        store,
        from,
        "research",
        (event) => event.files.length === 1 && allSynced(event),
      );
      assert.deepStrictEqual(machines.files(hub), { "keep.txt": "keep" });
      assert.deepStrictEqual(machines.files(laptop), { "keep.txt": "keep" });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a machine whose agents left the workspace keeps its copies but gets no more changes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const machines = yield* makeMachines;
        const { store, files } = yield* harness(machines);
        const flow = workflowWith("flow", "research", [
          agent("writer", laptop),
          agent("lead", hub),
        ]);
        yield* seedWorkspace(store, "research", [flow]);
        let from = yield* sequenceOf(store);
        yield* files.add("research", "a.txt", text("a"));
        yield* reached(store, from, "research", allSynced);

        from = yield* sequenceOf(store);
        yield* saveWorkflow(store, { ...flow, nodes: [agent("lead", hub)] });
        const left = yield* reached(store, from, "research", (event) =>
          event.machines.every((machine) => machine.environmentId !== laptop),
        );
        assert.deepStrictEqual(
          left.machines.map((machine) => machine.environmentId),
          [hub],
        );
        from = yield* sequenceOf(store);
        yield* files.add("research", "b.txt", text("b"));
        yield* files.remove("research", "a.txt");
        yield* reached(
          store,
          from,
          "research",
          (event) => event.files.map((file) => file.name).join() === "b.txt" && allSynced(event),
        );
        assert.deepStrictEqual(machines.files(hub), { "b.txt": "b" });
        assert.deepStrictEqual(machines.files(laptop), { "a.txt": "a" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a workspace's files never reach another workspace's machines", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const machines = yield* makeMachines;
      const { store, files } = yield* harness(machines);
      yield* seedWorkspace(store, "research", [
        workflowWith("flow", "research", [agent("writer", laptop)]),
      ]);
      yield* seedWorkspace(store, "ops", [workflowWith("deploy", "ops", [agent("ops", vps)])]);
      const from = yield* sequenceOf(store);
      yield* files.add("research", "secret.txt", text("s"));
      yield* files.add("ops", "runbook.md", text("r"));
      yield* reached(store, from, "research", allSynced);
      yield* reached(store, from, "ops", allSynced);
      assert.deepStrictEqual(machines.files(vps), { "runbook.md": "r" });
      assert.deepStrictEqual(machines.files(laptop), { "secret.txt": "s" });
      const snapshot = yield* store.snapshot();
      assert.deepStrictEqual(
        snapshot.files.map((entry) => [entry.workspaceId, entry.files.map((file) => file.name)]),
        [
          ["research", ["secret.txt"]],
          ["ops", ["runbook.md"]],
        ],
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("an offline machine shows why it has no copy and catches up once it is back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const machines = yield* makeMachines;
      const { store, files } = yield* harness(machines);
      yield* seedWorkspace(store, "research", [
        workflowWith("flow", "research", [agent("writer", laptop)]),
      ]);
      machines.offline.add(laptop);
      let from = yield* sequenceOf(store);
      yield* files.add("research", "notes.txt", text("n"));
      const failed = yield* reached(store, from, "research", (event) =>
        event.machines.some((machine) => machine.status === "failed"),
      );
      assert.deepStrictEqual(
        failed.machines.find((machine) => machine.environmentId === laptop),
        { environmentId: laptop, status: "failed", error: "Laptop is offline." },
      );
      machines.offline.delete(laptop);
      from = yield* sequenceOf(store);
      yield* store.transaction(
        store.appendEvent({
          kind: "peer.upserted",
          peer: {
            id: "laptop",
            name: "Laptop",
            environmentId: laptop,
            url: "http://laptop",
            status: "connected",
          },
        }),
      );
      yield* reached(store, from, "research", allSynced);
      assert.deepStrictEqual(machines.files(laptop), { "notes.txt": "n" });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a run starts while files are still copying, and its agents are told about them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const machines = yield* makeMachines;
      const sends = yield* Queue.unbounded<string>();
      const { store, files, engine } = yield* harness(machines, {
        driver: {
          ...driver,
          send: (input) =>
            Queue.offer(sends, input.text).pipe(
              Effect.as({ runId: RunId.make(input.messageId), sequence: 0 }),
            ),
        },
      });
      yield* seedWorkspace(store, "research", [
        workflowWith("flow", "research", [agent("writer", laptop)]),
      ]);
      const gate = yield* Deferred.make<void>();
      machines.gates.set(laptop, gate);
      yield* files.add("research", "brief.pdf", text("%PDF"));
      yield* engine.start("flow", { id: "run:1", task: "Summarise the brief" });
      const instructions = yield* Queue.take(sends);
      assert.include(instructions, "~/t3-workspaces/research/shared-files");
      assert.include(instructions, "- brief.pdf");
      assert.deepStrictEqual(machines.files(laptop), {});
      yield* Deferred.succeed(gate, undefined);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a file that reached a machine without the hub hearing back is still deleted there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const machines = yield* makeMachines;
      const { store, files } = yield* harness(machines);
      yield* seedWorkspace(store, "research", [
        workflowWith("flow", "research", [agent("writer", laptop)]),
      ]);
      machines.silent.add(laptop);
      let from = yield* sequenceOf(store);
      yield* files.add("research", "draft.txt", text("d"));
      yield* reached(store, from, "research", (event) =>
        event.machines.some((machine) => machine.status === "failed"),
      );
      assert.deepStrictEqual(machines.files(laptop), { "draft.txt": "d" });
      from = yield* sequenceOf(store);
      yield* files.remove("research", "draft.txt");
      yield* reached(
        store,
        from,
        "research",
        (event) =>
          event.files.length === 0 &&
          event.machines.every((machine) => machine.status === "synced"),
      );
      assert.deepStrictEqual(machines.files(laptop), {});
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("names that differ only by case are refused, since some machines cannot keep both", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const machines = yield* makeMachines;
      const { store, files } = yield* harness(machines);
      yield* seedWorkspace(store, "research", []);
      yield* files.add("research", "Notes.txt", text("a"));
      const refused = yield* files.add("research", "notes.txt", text("b")).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "BoardInvalidRequestError");
      yield* files.add("research", "Notes.txt", text("c"));
      assert.deepStrictEqual(
        (yield* store.listWorkspaceFiles("research")).map((file) => [file.name, file.size]),
        [["Notes.txt", 1]],
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a replacement whose answer was lost is sent again when the old version comes back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const machines = yield* makeMachines;
      const { store, files } = yield* harness(machines);
      yield* seedWorkspace(store, "research", [
        workflowWith("flow", "research", [agent("writer", laptop)]),
      ]);
      let from = yield* sequenceOf(store);
      yield* files.add("research", "plan.txt", text("A"));
      yield* reached(store, from, "research", allSynced);
      machines.silent.add(laptop);
      from = yield* sequenceOf(store);
      yield* files.add("research", "plan.txt", text("B"));
      yield* reached(store, from, "research", (event) =>
        event.machines.some((machine) => machine.status === "failed"),
      );
      machines.silent.delete(laptop);
      from = yield* sequenceOf(store);
      yield* files.add("research", "plan.txt", text("A"));
      yield* reached(store, from, "research", allSynced);
      assert.deepStrictEqual(machines.files(laptop), { "plan.txt": "A" });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
