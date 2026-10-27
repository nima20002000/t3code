import { NodeDriverError, type NodeDriver } from "@t3tools/board-core";
import { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ThreadLaunch, ThreadManagement } from "./upstream.ts";

export class LocalDriver extends Context.Service<LocalDriver, NodeDriver>()(
  "t3/board/LocalDriver",
) {}

const make = Effect.gen(function* () {
  const launchService = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const error = (operation: NodeDriverError["operation"]) => (cause: unknown) =>
    new NodeDriverError({ operation, message: `Local board driver ${operation} failed.`, cause });

  const launch: NodeDriver["launch"] = Effect.fn("LocalDriver.launch")(function* (input) {
    const { reuseExistingThread, generateTitle, initialMessage, ...required } = input.launch;
    const result = yield* launchService
      .launch({
        ...required,
        ...(reuseExistingThread === undefined ? {} : { reuseExistingThread }),
        ...(generateTitle === undefined ? {} : { generateTitle }),
        ...(initialMessage === undefined
          ? {}
          : {
              initialMessage: {
                messageId: initialMessage.messageId,
                text: initialMessage.text,
                attachments: initialMessage.attachments,
                ...(initialMessage.context === undefined
                  ? {}
                  : { context: initialMessage.context }),
              },
            }),
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.mapError(error("launch")));
    return {
      environmentId: input.environmentId,
      projectId: input.launch.projectId,
      threadId: result.threadId,
    };
  });
  const send: NodeDriver["send"] = Effect.fn("LocalDriver.send")(function* (input) {
    const result = yield* threads
      .sendToThread({
        projectId: input.thread.projectId,
        threadId: input.thread.threadId,
        commandId: input.commandId,
        messageId: input.messageId,
        text: input.text,
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.mapError(error("send")));
    return { runId: result.run.id, sequence: result.dispatch.sequence };
  });
  const subscribeSettled: NodeDriver["subscribeSettled"] = (input) =>
    threads
      .streamStoredEventsFrom({
        threadId: input.thread.threadId,
        afterSequence: input.afterSequence ?? 0,
        eventType: "run.updated",
      })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
              stored.event.payload.status,
            ),
        ),
        Stream.mapEffect(
          Effect.fn("LocalDriver.settled")(function* (stored) {
            if (stored.event.type !== "run.updated") return null;
            const result = yield* threads.waitForThread({
              projectId: input.thread.projectId,
              threadId: input.thread.threadId,
              runId: stored.event.payload.id,
              timeoutMs: 86_400_000,
            });
            const run = result.run;
            if (
              result.timedOut ||
              run === null ||
              !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                run.status,
              )
            )
              return null;
            return {
              thread: input.thread,
              runId: run.id,
              messageId: run.userMessageId,
              status: run.status as
                | "completed"
                | "failed"
                | "cancelled"
                | "interrupted"
                | "rolled_back",
              sequence: stored.sequence,
            };
          }),
        ),
        Stream.filter((value) => value !== null),
        Stream.mapError(error("subscribeSettled")),
      );
  const readLatestAssistant: NodeDriver["readLatestAssistant"] = Effect.fn(
    "LocalDriver.readLatestAssistant",
  )(function* (input) {
    const records = yield* threads
      .getProjectThreadRecords(input.thread, ["messages"])
      .pipe(Effect.mapError(error("readLatestAssistant")));
    const message = records.messages
      .filter(
        (candidate) =>
          candidate.role === "assistant" &&
          !candidate.streaming &&
          (input.runId === undefined || candidate.runId === input.runId),
      )
      .at(-1);
    return message === undefined ? null : { id: message.id, text: message.text };
  });
  const interrupt: NodeDriver["interrupt"] = Effect.fn("LocalDriver.interrupt")(function* (input) {
    if (input.runId !== undefined) {
      const records = yield* threads
        .getProjectThreadRecords(input.thread, ["runs"])
        .pipe(Effect.mapError(error("interrupt")));
      const run = records.runs.find((candidate) => candidate.id === input.runId);
      if (run?.status === "queued") {
        const cancelled = yield* threads
          .dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`${input.commandId}:cancel-queued`),
            threadId: input.thread.threadId,
            runId: input.runId,
          })
          .pipe(Effect.result);
        if (Result.isSuccess(cancelled)) return;
        const refreshed = yield* threads
          .getProjectThreadRecords(input.thread, ["runs"])
          .pipe(Effect.mapError(error("interrupt")));
        if (refreshed.runs.find((candidate) => candidate.id === input.runId)?.status === "queued")
          return yield* error("interrupt")(cancelled.failure);
      }
    }
    yield* threads
      .interruptThread({
        projectId: input.thread.projectId,
        threadId: input.thread.threadId,
        commandId: input.commandId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
      })
      .pipe(Effect.mapError(error("interrupt")));
  });
  return LocalDriver.of({ launch, send, subscribeSettled, readLatestAssistant, interrupt });
});

export const layer = Layer.effect(LocalDriver, make);
