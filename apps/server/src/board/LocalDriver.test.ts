import { assert, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as LocalDriver from "./LocalDriver.ts";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  ProjectService,
  ProjectStore,
  ScheduledTasks,
  ThreadLaunch,
  ThreadManagement,
} from "./upstream.ts";

const thread = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
};
const run = (id: string, userMessageId: string, status: string) => ({
  id: RunId.make(id),
  userMessageId: MessageId.make(userMessageId),
  status,
});

it.effect("matches a run finished by a restart continuation to the message that started it", () =>
  Effect.gen(function* () {
    // The board message started run 1; a server restart cut it and t3 finished the turn in run 2.
    const threads = ThreadManagement.ThreadManagementService.of({
      streamStoredEventsFrom: () =>
        Stream.make({
          sequence: 10,
          event: { type: "run.updated", payload: run("run-1", "board-message", "interrupted") },
        }),
      waitForThread: () =>
        Effect.succeed({
          run: run("run-2", "restart-continuation-message", "completed"),
          timedOut: false,
        }),
    } as never);
    const layer = LocalDriver.layer.pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(ThreadManagement.ThreadManagementService, threads)),
      Layer.provide(
        Layer.succeed(
          ThreadLaunch.ThreadLaunchService,
          ThreadLaunch.ThreadLaunchService.of({} as never),
        ),
      ),
      Layer.provide(
        Layer.succeed(ProjectService.ProjectService, ProjectService.ProjectService.of({} as never)),
      ),
      Layer.provide(
        Layer.succeed(ProjectStore.ProjectStoreV2, ProjectStore.ProjectStoreV2.of({} as never)),
      ),
      Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
    );
    const settled = yield* Effect.gen(function* () {
      const driver = yield* LocalDriver.LocalDriver;
      return yield* driver.subscribeSettled({ thread, afterSequence: 0 }).pipe(Stream.runHead);
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(
      settled._tag === "Some"
        ? {
            runId: settled.value.runId,
            messageId: settled.value.messageId,
            status: settled.value.status,
          }
        : null,
      {
        runId: RunId.make("run-2"),
        messageId: MessageId.make("board-message"),
        status: "completed",
      },
    );
  }),
);

const projectDriver = (
  projects: Partial<ProjectService.ProjectService["Service"]>,
  rows: ReadonlyArray<{ projectId: ProjectId; workspaceRoot: string }> = [],
) =>
  LocalDriver.layer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.succeed(
        ThreadManagement.ThreadManagementService,
        ThreadManagement.ThreadManagementService.of({} as never),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        ThreadLaunch.ThreadLaunchService,
        ThreadLaunch.ThreadLaunchService.of({} as never),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        ProjectService.ProjectService,
        ProjectService.ProjectService.of(projects as never),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        ProjectStore.ProjectStoreV2,
        ProjectStore.ProjectStoreV2.of({
          get: (id: ProjectId) =>
            Effect.succeed(Option.fromUndefinedOr(rows.find((row) => row.projectId === id))),
          list: () => Effect.succeed(rows),
        } as never),
      ),
    ),
    Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
  );

it.effect("creates a missing workspace project with its folder, and leaves an existing one", () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const existing = yield* Ref.make(false);
    const layer = projectDriver({
      getById: () =>
        Ref.get(existing).pipe(
          Effect.map((has) => (has ? Option.some({} as never) : Option.none())),
        ),
      create: (input) => Ref.update(created, (all) => [...all, input]).pipe(Effect.as({} as never)),
    });
    yield* Effect.gen(function* () {
      const driver = yield* LocalDriver.LocalDriver;
      const input = {
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        title: "Workspace",
        path: "~/t3-workspaces/workspace",
      };
      yield* driver.ensureProject(input);
      assert.deepStrictEqual(yield* Ref.get(created), [
        {
          commandId: "board:project:project",
          projectId: thread.projectId,
          title: "Workspace",
          workspaceRoot: "~/t3-workspaces/workspace",
          createWorkspaceRootIfMissing: true,
        },
      ]);
      yield* Ref.set(existing, true);
      yield* driver.ensureProject(input);
      assert.strictEqual((yield* Ref.get(created)).length, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("removes a workspace project with its threads and tolerates one already gone", () =>
  Effect.gen(function* () {
    const deleted = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const layer = projectDriver({
      delete: (input) =>
        Ref.update(deleted, (all) => [...all, input]).pipe(
          Effect.andThen(
            Effect.fail(new ProjectService.ProjectNotFoundError({ projectId: input.projectId })),
          ),
        ),
    });
    yield* Effect.gen(function* () {
      const driver = yield* LocalDriver.LocalDriver;
      yield* driver.deleteProject({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
      });
      assert.deepStrictEqual(yield* Ref.get(deleted), [
        { commandId: "board:project-delete:project", projectId: thread.projectId, force: true },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "removes the confirmed folder before the project, and keeps the project if that fails",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parent = yield* fileSystem.makeTempDirectory({ prefix: "board-driver-" });
      const root = `${parent}/own`;
      yield* fileSystem.makeDirectory(root);
      yield* fileSystem.makeDirectory(`${parent}/elsewhere`);
      const deleted = yield* Ref.make(0);
      const layer = projectDriver(
        {
          delete: () => Ref.update(deleted, (n) => n + 1).pipe(Effect.as({} as never)),
        },
        [{ projectId: thread.projectId, workspaceRoot: root }],
      );
      yield* Effect.gen(function* () {
        const driver = yield* LocalDriver.LocalDriver;
        const input = { environmentId: thread.environmentId, projectId: thread.projectId };
        yield* driver.deleteProject(input);
        assert.isTrue(yield* fileSystem.exists(root));
        const refused = yield* driver
          .deleteProject({ ...input, removeFolderPath: `${parent}/elsewhere` })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "NodeDriverError");
        assert.isTrue(yield* fileSystem.exists(root));
        assert.strictEqual(yield* Ref.get(deleted), 1);
        yield* driver.deleteProject({ ...input, removeFolderPath: root });
        assert.isFalse(yield* fileSystem.exists(root));
        assert.strictEqual(yield* Ref.get(deleted), 2);
      }).pipe(Effect.provide(layer));
      yield* fileSystem.remove(parent, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("adopts a folder that already exists so the board never deletes it", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectory();
    const layer = projectDriver({
      getById: () => Effect.succeedNone,
      create: () => Effect.succeed({} as never),
    });
    yield* Effect.gen(function* () {
      const driver = yield* LocalDriver.LocalDriver;
      const input = {
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        title: "Workspace",
      };
      assert.deepStrictEqual(yield* driver.ensureProject({ ...input, path: dir }), {
        adopted: true,
      });
      assert.deepStrictEqual(yield* driver.ensureProject({ ...input, path: `${dir}/new` }), {
        adopted: false,
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("Stop leaves nothing running after a restart cut the run, continued or not", () =>
  Effect.gen(function* () {
    // A minimal t3 thread: run.interrupt stops a live run, thread.stop also declines a pending
    // restart continuation, and a continuation t3 starts later runs unless Stop reached the thread.
    const runs = yield* Ref.make<ReadonlyArray<ReturnType<typeof run> & object>>([]);
    const stopped = yield* Ref.make(false);
    const threads = ThreadManagement.ThreadManagementService.of({
      getProjectThreadRecords: () => Ref.get(runs).pipe(Effect.map((all) => ({ runs: all }))),
      interruptThread: (input: { readonly runId?: RunId }) =>
        Ref.update(runs, (all) =>
          all.map((entry) =>
            entry.id === input.runId && entry.status === "running"
              ? { ...entry, status: "interrupted" }
              : entry,
          ),
        ).pipe(Effect.as({ type: "interrupt_requested" })),
      dispatch: (command: { readonly type: string }) =>
        (command.type === "thread.stop" ? Ref.set(stopped, true) : Effect.void).pipe(
          Effect.as({ sequence: 1 }),
        ),
    } as never);
    const continuePending = Effect.gen(function* () {
      if (yield* Ref.get(stopped)) return;
      yield* Ref.update(runs, (all) => [
        ...all,
        { ...run("run-2", "continue", "running"), restartContinuationOfRunId: "run-1" },
      ]);
    });
    const layer = LocalDriver.layer.pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(ThreadManagement.ThreadManagementService, threads)),
      Layer.provide(
        Layer.succeed(
          ThreadLaunch.ThreadLaunchService,
          ThreadLaunch.ThreadLaunchService.of({} as never),
        ),
      ),
      Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
      Layer.provide(
        Layer.succeed(ProjectService.ProjectService, ProjectService.ProjectService.of({} as never)),
      ),
      Layer.provide(
        Layer.succeed(ProjectStore.ProjectStoreV2, ProjectStore.ProjectStoreV2.of({} as never)),
      ),
    );
    const cut = { ...run("run-1", "board-message", "cancelled"), startedAt: "started" };
    const running = Ref.get(runs).pipe(
      Effect.map((all) => all.filter((entry) => entry.status === "running").map((e) => e.id)),
    );
    yield* Effect.gen(function* () {
      const driver = yield* LocalDriver.LocalDriver;
      const stop = driver.interrupt({
        thread,
        runId: RunId.make("run-1"),
        commandId: "stop" as never,
      });
      // t3 already continued the cut run.
      yield* Ref.set(runs, [cut]);
      yield* continuePending;
      yield* stop;
      assert.deepStrictEqual(yield* running, []);
      // t3 has not continued it yet when Stop lands.
      yield* Ref.set(runs, [cut]);
      yield* stop;
      yield* continuePending;
      assert.deepStrictEqual(yield* running, []);
      // The board never learned the cut run's id (its send was uncertain).
      yield* Ref.set(runs, [cut]);
      yield* Ref.set(stopped, false);
      yield* driver.interrupt({ thread, commandId: "stop-unknown" as never });
      yield* continuePending;
      assert.deepStrictEqual(yield* running, []);
    }).pipe(Effect.provide(layer));
  }),
);
