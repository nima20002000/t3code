import { assert, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";
import * as Stream from "effect/Stream";
import * as LocalDriver from "./LocalDriver.ts";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ProjectService, ThreadLaunch, ThreadManagement } from "./upstream.ts";

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

const projectDriver = (projects: Partial<ProjectService.ProjectService["Service"]>) =>
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

it.effect("deletes a board-created folder under ~/t3-workspaces, never one elsewhere", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inside = path.join(NodeOS.homedir(), "t3-workspaces", `board-test-${process.pid}`);
    const outside = yield* fileSystem.makeTempDirectory({ prefix: "board-outside-" });
    yield* fileSystem.makeDirectory(inside, { recursive: true });
    for (const [root, kept] of [
      [inside, false],
      [outside, true],
    ] as const) {
      const layer = projectDriver({
        getById: () => Effect.succeedSome({ workspaceRoot: root } as never),
        delete: () => Effect.succeed({} as never),
      });
      yield* Effect.gen(function* () {
        const driver = yield* LocalDriver.LocalDriver;
        yield* driver.deleteProject({
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          removeFolder: true,
        });
      }).pipe(Effect.provide(layer));
      assert.strictEqual(yield* fileSystem.exists(root), kept);
    }
    yield* fileSystem.remove(outside, { recursive: true });
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

it.effect("Stop reaches the continuation of a cut run, or declines a pending one", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const runs = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const record = (call: unknown) => Ref.update(calls, (all) => [...all, call]);
    const threads = ThreadManagement.ThreadManagementService.of({
      getProjectThreadRecords: () => Ref.get(runs).pipe(Effect.map((all) => ({ runs: all }))),
      interruptThread: (input: { readonly runId?: RunId }) =>
        record({ interrupt: input.runId }).pipe(Effect.as({ type: "no_active_run" })),
      dispatch: (command: { readonly type: string }) =>
        record({ dispatch: command.type }).pipe(Effect.as({ sequence: 1 })),
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
    );
    const cut = { ...run("run-1", "board-message", "cancelled"), startedAt: "started" };
    yield* Effect.gen(function* () {
      const driver = yield* LocalDriver.LocalDriver;
      const stop = driver.interrupt({
        thread,
        runId: RunId.make("run-1"),
        commandId: "stop" as never,
      });
      yield* Ref.set(runs, [
        cut,
        { ...run("run-2", "continue", "running"), restartContinuationOfRunId: "run-1" },
      ]);
      yield* stop;
      yield* Ref.set(runs, [cut]);
      yield* stop;
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(yield* Ref.get(calls), [
      { interrupt: RunId.make("run-2") },
      { dispatch: "thread.stop" },
    ]);
  }),
);
