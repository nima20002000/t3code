import { assert, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as LocalDriver from "./LocalDriver.ts";
import { ThreadLaunch, ThreadManagement } from "./upstream.ts";

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
      Layer.provide(Layer.succeed(ThreadManagement.ThreadManagementService, threads)),
      Layer.provide(
        Layer.succeed(
          ThreadLaunch.ThreadLaunchService,
          ThreadLaunch.ThreadLaunchService.of({} as never),
        ),
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
