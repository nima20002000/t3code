// @effect-diagnostics-next-line nodeBuiltinImport:off -- Task ids are derived synchronously from the node.
import * as NodeCrypto from "node:crypto";
import {
  BoardInternalError,
  BoardNotFoundError,
  type BoardConflictError,
  type BoardInvalidRequestError,
  type BoardNewNodeChatInput,
  type BoardNode,
  type BoardSaveNodeScheduleInput,
  type NodeDriver,
  type NodeDriverError,
} from "@t3tools/board-core";
import {
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as TaskEngine from "./TaskEngine.ts";

type Marker = NonNullable<BoardNode["schedule"]>;
type Chat = NonNullable<BoardNode["chat"]>;
type ScheduleError =
  | SqlError
  | BoardNotFoundError
  | BoardInternalError
  | BoardConflictError
  | BoardInvalidRequestError;

/**
 * An agent's schedule is a t3 scheduled task on its chat's machine, bound to the chat thread, so
 * that machine fires it (and stops after its runs) while the hub is off. The node keeps a marker
 * pointing at it so deletes, moves and "/new" can follow it.
 */
export class AgentSchedules extends Context.Service<
  AgentSchedules,
  {
    readonly save: (
      workflowId: string,
      nodeId: string,
      input: BoardSaveNodeScheduleInput,
    ) => Effect.Effect<BoardNode, ScheduleError>;
    readonly setEnabled: (
      workflowId: string,
      nodeId: string,
      enabled: boolean,
    ) => Effect.Effect<void, ScheduleError>;
    readonly remove: (workflowId: string, nodeId: string) => Effect.Effect<void, ScheduleError>;
    /** Points the schedule at the chat "/new" just started, with that chat's settings. */
    readonly retarget: (
      workflowId: string,
      nodeId: string,
      settings: BoardNewNodeChatInput,
    ) => Effect.Effect<void, ScheduleError>;
    /** Moves the node's chat to the thread a "new chat" firing started on the machine. */
    readonly sync: (workflowId: string, nodeId: string) => Effect.Effect<void, ScheduleError>;
    /** Deletes the nodes' tasks before the nodes go; fails while a paired machine is unreachable. */
    readonly release: (nodes: ReadonlyArray<BoardNode>) => Effect.Effect<void, BoardInternalError>;
  }
>()("t3/board/AgentSchedules") {}

const taskIdFor = (workflowId: string, nodeId: string) =>
  ScheduledTaskId.make(
    `board:${NodeCrypto.createHash("sha256").update(`schedule\0${workflowId}\0${nodeId}`).digest("hex")}`,
  );

const unreachable = (action: string) => (cause: NodeDriverError) =>
  new BoardInternalError({
    message: `Could not ${action} on the agent's machine: ${cause.message}`,
  });

/** The saved task as an upsert, so a change to one field keeps every other one. */
function upsertOf(
  task: ScheduledTask,
): (ScheduledTaskUpsertInput & { readonly id: ScheduledTaskId }) | undefined {
  if (task.schedule.type === "webhook") return undefined;
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    schedule: task.schedule,
    projectId: task.projectId,
    threadId: task.threadId,
    maxRuns: task.maxRuns ?? null,
    beforeRun: task.beforeRun ?? null,
    workspaceStrategy: task.workspaceStrategy,
    modelSelection: task.modelSelection,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
  };
}

/** A "new chat" firing rebinds the task on the machine; it is newer than the chat the board has. */
const movedByMachine = (task: ScheduledTask, chat: Chat) =>
  task.threadId !== null &&
  task.threadId !== chat.threadId &&
  (chat.startedAt === undefined || task.updatedAt > chat.startedAt);

const make = Effect.gen(function* () {
  const store = yield* BoardStore.BoardStore;
  const drivers = yield* DriverRegistry.DriverRegistry;
  const engine = yield* TaskEngine.TaskEngine;

  const findNode = Effect.fn("AgentSchedules.findNode")(function* (
    workflowId: string,
    nodeId: string,
  ) {
    const workflow = yield* store.getWorkflow(workflowId);
    const node = workflow?.nodes.find((entry) => entry.id === nodeId);
    if (!workflow || !node) return yield* new BoardNotFoundError({ message: "Node not found." });
    return { workflow, node };
  });
  const scheduled = Effect.fn("AgentSchedules.scheduled")(function* (
    workflowId: string,
    nodeId: string,
  ) {
    const { node } = yield* findNode(workflowId, nodeId);
    if (!node.schedule)
      return yield* new BoardNotFoundError({ message: "This agent has no schedule." });
    return node.schedule;
  });
  const driverFor = (environmentId: Marker["environmentId"], action: string) =>
    drivers.get(environmentId).pipe(Effect.mapError(unreachable(action)));
  const patchNode = Effect.fn("AgentSchedules.patchNode")(function* (
    workflowId: string,
    nodeId: string,
    patch: (node: BoardNode) => BoardNode,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        const { workflow, node } = yield* findNode(workflowId, nodeId);
        const next = patch(node);
        const saved = {
          ...workflow,
          nodes: workflow.nodes.map((entry) => (entry.id === nodeId ? next : entry)),
        };
        yield* store.putWorkflow(saved);
        yield* store.appendEvent({ kind: "workflow.upserted", workflow: saved });
        return next;
      }),
    );
  });
  const setMarker = (workflowId: string, nodeId: string, marker: Marker | undefined) =>
    patchNode(workflowId, nodeId, ({ schedule: _old, ...rest }) =>
      marker ? { ...rest, schedule: marker } : rest,
    );
  /** The node's chat follows a thread the machine moved the schedule to, when it is newer. */
  const adopt = Effect.fn("AgentSchedules.adopt")(function* (
    workflowId: string,
    nodeId: string,
    marker: Marker,
    task: ScheduledTask,
  ) {
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const node = yield* patchNode(workflowId, nodeId, (current) =>
      current.chat?.environmentId === marker.environmentId &&
      task.threadId !== null &&
      movedByMachine(task, current.chat)
        ? {
            ...current,
            chat: {
              environmentId: marker.environmentId,
              projectId: task.projectId,
              threadId: task.threadId,
              startedAt,
            },
          }
        : current,
    );
    return node.chat;
  });
  const deleteTask = Effect.fn("AgentSchedules.deleteTask")(function* (marker: Marker) {
    const driver = yield* driverFor(marker.environmentId, "remove the schedule");
    yield* driver
      .deleteScheduledTask(marker)
      .pipe(Effect.mapError(unreachable("remove the schedule")));
  });
  const readTask = (driver: NodeDriver, marker: Marker, action: string) =>
    driver.getScheduledTask(marker).pipe(Effect.mapError(unreachable(action)));

  const save = Effect.fn("AgentSchedules.save")(function* (
    workflowId: string,
    nodeId: string,
    input: BoardSaveNodeScheduleInput,
  ) {
    const { workflow, node } = yield* findNode(workflowId, nodeId);
    const opened = (yield* engine.openNodeChat(workflowId, nodeId)).chat;
    if (!opened) return yield* new BoardInternalError({ message: "The agent has no chat." });
    if (node.schedule && node.schedule.environmentId !== opened.environmentId)
      yield* deleteTask(node.schedule);
    const marker = { environmentId: opened.environmentId, taskId: taskIdFor(workflowId, nodeId) };
    const driver = yield* driverFor(marker.environmentId, "save the schedule");
    // Read before marking, so an unreachable machine leaves nothing behind.
    const existing = yield* readTask(driver, marker, "save the schedule");
    const chat = (existing && (yield* adopt(workflowId, nodeId, marker, existing))) || opened;
    // The marker goes before the write, so a save whose outcome is unknown can be cleaned up.
    yield* setMarker(workflowId, nodeId, marker);
    const maxRuns = (existing?.runCount ?? 0) + input.runs;
    const task = yield* driver
      .upsertScheduledTask({
        environmentId: marker.environmentId,
        task: {
          id: marker.taskId,
          title: `${node.name} · ${workflow.name}`,
          prompt: input.prompt,
          enabled: true,
          schedule: input.timing,
          maxRuns,
          beforeRun: input.beforeRun === "none" ? null : input.beforeRun,
          projectId: chat.projectId,
          threadId: chat.threadId,
          workspaceStrategy: { type: "root" },
          modelSelection: existing?.modelSelection ?? node.modelSelection,
          runtimeMode: existing?.runtimeMode ?? node.runtimeMode ?? workflow.settings.runtimeMode,
          interactionMode: existing?.interactionMode ?? "default",
        },
      })
      .pipe(
        Effect.mapError(unreachable("save the schedule")),
        Effect.tapError(() =>
          existing
            ? Effect.void
            : driver
                .deleteScheduledTask(marker)
                .pipe(Effect.andThen(setMarker(workflowId, nodeId, undefined)), Effect.ignore),
        ),
      );
    // A t3 without run limits ignores maxRuns, so the task would never stop.
    if (task.maxRuns !== maxRuns) {
      yield* driver.deleteScheduledTask(marker).pipe(Effect.ignore);
      yield* setMarker(workflowId, nodeId, undefined);
      return yield* new BoardInternalError({
        message:
          "The agent's machine runs a t3 that cannot stop a schedule after a number of runs. Update it to the board's t3 build.",
      });
    }
    return (yield* findNode(workflowId, nodeId)).node;
  });

  const setEnabled = Effect.fn("AgentSchedules.setEnabled")(function* (
    workflowId: string,
    nodeId: string,
    enabled: boolean,
  ) {
    const marker = yield* scheduled(workflowId, nodeId);
    const driver = yield* driverFor(marker.environmentId, "update the schedule");
    yield* driver
      .setScheduledTaskEnabled({ ...marker, enabled })
      .pipe(Effect.mapError(unreachable("update the schedule")));
  });

  const remove = Effect.fn("AgentSchedules.remove")(function* (workflowId: string, nodeId: string) {
    yield* deleteTask(yield* scheduled(workflowId, nodeId));
    yield* setMarker(workflowId, nodeId, undefined);
  });

  const retarget = Effect.fn("AgentSchedules.retarget")(function* (
    workflowId: string,
    nodeId: string,
    settings: BoardNewNodeChatInput,
  ) {
    const { node } = yield* findNode(workflowId, nodeId);
    const marker = node.schedule;
    const chat = node.chat;
    if (!marker || !chat) return;
    if (marker.environmentId !== chat.environmentId) {
      yield* deleteTask(marker);
      yield* setMarker(workflowId, nodeId, undefined);
      return;
    }
    const action = "move the schedule to the new chat";
    const driver = yield* driverFor(marker.environmentId, action);
    const existing = yield* readTask(driver, marker, action);
    if (existing === null)
      return yield* setMarker(workflowId, nodeId, undefined).pipe(Effect.asVoid);
    const input = upsertOf(existing);
    if (!input)
      return yield* new BoardInternalError({
        message: "The agent's schedule was changed to a webhook in t3.",
      });
    yield* driver
      .upsertScheduledTask({
        environmentId: marker.environmentId,
        task: {
          ...input,
          projectId: chat.projectId,
          threadId: chat.threadId,
          ...settings,
        },
      })
      .pipe(Effect.mapError(unreachable(action)));
  });

  const sync = Effect.fn("AgentSchedules.sync")(function* (workflowId: string, nodeId: string) {
    const { node } = yield* findNode(workflowId, nodeId);
    const marker = node.schedule;
    if (!marker) return;
    const driver = yield* driverFor(marker.environmentId, "read the schedule");
    const task = yield* readTask(driver, marker, "read the schedule");
    if (task) yield* adopt(workflowId, nodeId, marker, task);
  });

  const release = Effect.fn("AgentSchedules.release")(function* (nodes: ReadonlyArray<BoardNode>) {
    for (const node of nodes) {
      const marker = node.schedule;
      if (!marker) continue;
      const driver = yield* drivers.get(marker.environmentId).pipe(Effect.option);
      // An unpaired machine can never be reached again; its task stays out of the board's hands.
      if (driver._tag === "None") {
        yield* Effect.logWarning("Agent schedule left on an unpaired machine", {
          nodeId: node.id,
          environmentId: marker.environmentId,
        });
        continue;
      }
      yield* driver.value.deleteScheduledTask(marker).pipe(
        Effect.mapError(
          (cause) =>
            new BoardInternalError({
              message: `Could not remove ${node.name}'s schedule from its machine: ${cause.message} Try again when the machine is online.`,
            }),
        ),
      );
    }
  });

  return AgentSchedules.of({ save, setEnabled, remove, retarget, sync, release });
});

export const layer = Layer.effect(AgentSchedules, make);
