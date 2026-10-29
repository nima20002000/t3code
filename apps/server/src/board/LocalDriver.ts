import { NodeDriverError, type NodeDriver } from "@t3tools/board-core";
import { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { CONTINUE_TEXT, continuationIds, latestContinuation } from "./restartContinuation.ts";
import { ProjectService, ThreadLaunch, ThreadManagement } from "./upstream.ts";

export class LocalDriver extends Context.Service<LocalDriver, NodeDriver>()(
  "t3/board/LocalDriver",
) {}

const make = Effect.gen(function* () {
  const launchService = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
  const resume: NodeDriver["resume"] = Effect.fn("LocalDriver.resume")(
    function* (input) {
      const source = (yield* threads.getProjectThreadRecords(input.thread, ["runs"])).runs.find(
        (candidate) => candidate.id === input.runId,
      );
      if (!source || source.status !== "cancelled" || source.startedAt === null) return null;
      const { commandId, messageId } = continuationIds(source.id);
      const dispatched = yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId: input.thread.threadId,
        messageId,
        text: CONTINUE_TEXT,
        attachments: [],
        modelSelection: source.modelSelection,
        createdBy: "system",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
        restartContinuationOfRunId: source.id,
      });
      const run = (yield* threads.getProjectThreadRecords(input.thread, ["runs"])).runs.find(
        (candidate) => candidate.userMessageId === messageId,
      );
      return run ? { runId: run.id, sequence: dispatched.sequence, messageId } : null;
    },
    Effect.mapError(error("resume")),
  );
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
              // waitForThread follows restart continuations; the settle belongs to the message that started the cut run.
              messageId: stored.event.payload.userMessageId,
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
    let runId = input.runId;
    if (input.runId !== undefined) {
      const records = yield* threads
        .getProjectThreadRecords(input.thread, ["runs"])
        .pipe(Effect.mapError(error("interrupt")));
      const found = records.runs.find((candidate) => candidate.id === input.runId);
      // A restart may have cut the run and continued it; Stop reaches the continuation.
      const run = found && latestContinuation(records.runs, found);
      runId = run?.id ?? runId;
      if (run?.status === "cancelled" && run.startedAt !== null) {
        // Its continuation may still be pending; a thread Stop declines it.
        yield* threads
          .dispatch({
            type: "thread.stop",
            commandId: input.commandId,
            threadId: input.thread.threadId,
          })
          .pipe(Effect.mapError(error("interrupt")));
        return;
      }
      if (run?.status === "queued") {
        const cancelled = yield* threads
          .dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`${input.commandId}:cancel-queued`),
            threadId: input.thread.threadId,
            runId: run.id,
          })
          .pipe(Effect.result);
        if (Result.isSuccess(cancelled)) return;
        const refreshed = yield* threads
          .getProjectThreadRecords(input.thread, ["runs"])
          .pipe(Effect.mapError(error("interrupt")));
        if (refreshed.runs.find((candidate) => candidate.id === run.id)?.status === "queued")
          return yield* error("interrupt")(cancelled.failure);
      }
    }
    yield* threads
      .interruptThread({
        projectId: input.thread.projectId,
        threadId: input.thread.threadId,
        commandId: input.commandId,
        ...(runId === undefined ? {} : { runId }),
      })
      .pipe(Effect.mapError(error("interrupt")));
  });
  const ensureProject: NodeDriver["ensureProject"] = Effect.fn("LocalDriver.ensureProject")(
    function* (input) {
      const existing = yield* projects.getById(input.projectId);
      if (Option.isSome(existing)) return { adopted: false };
      const adopted = yield* fileSystem.exists(
        input.path === "~" || input.path.startsWith("~/")
          ? path.join(NodeOS.homedir(), input.path.slice(2))
          : input.path,
      );
      yield* projects.create({
        commandId: CommandId.make(`board:project:${input.projectId}`),
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.path,
        createWorkspaceRootIfMissing: true,
      });
      return { adopted };
    },
    Effect.mapError(error("ensureProject")),
  );
  const deleteProject: NodeDriver["deleteProject"] = Effect.fn("LocalDriver.deleteProject")(
    function* (input) {
      const project = input.removeFolder ? yield* projects.getById(input.projectId) : Option.none();
      yield* projects
        .delete({
          commandId: CommandId.make(`board:project-delete:${input.projectId}`),
          projectId: input.projectId,
          force: true,
        })
        .pipe(Effect.catchTags({ ProjectNotFoundError: () => Effect.void }));
      if (Option.isNone(project)) return;
      // Only folders the board created under ~/t3-workspaces are ever deleted.
      const root = path.resolve(project.value.workspaceRoot);
      const boardRoot = path.join(NodeOS.homedir(), "t3-workspaces");
      if (root.startsWith(`${boardRoot}${path.sep}`))
        yield* fileSystem.remove(root, { recursive: true });
    },
    Effect.mapError(error("deleteProject")),
  );
  return LocalDriver.of({
    launch,
    send,
    resume,
    subscribeSettled,
    readLatestAssistant,
    interrupt,
    ensureProject,
    deleteProject,
  });
});

export const layer = Layer.effect(LocalDriver, make);
