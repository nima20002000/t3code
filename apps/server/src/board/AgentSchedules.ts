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
  taskScheduleOf,
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
import * as Semaphore from "effect/Semaphore";
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
    /**
     * Moves the node's chat to the thread a "new chat" firing started on the machine, or the task
     * to the node's chat when an earlier move did not reach the machine.
     */
    readonly sync: (workflowId: string, nodeId: string) => Effect.Effect<void, ScheduleError>;
    /** Runs a node delete or move, with its `release`, between schedule writes. */
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /**
     * Deletes the nodes' tasks before the nodes go; fails while a paired machine is unreachable.
     * Call it inside `exclusive`, with the delete that follows.
     */
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
    startAt: task.startAt ?? null,
    workspaceStrategy: task.workspaceStrategy,
    modelSelection: task.modelSelection,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
  };
}

const make = Effect.gen(function* () {
  const store = yield* BoardStore.BoardStore;
  const drivers = yield* DriverRegistry.DriverRegistry;
  const engine = yield* TaskEngine.TaskEngine;
  // Schedule writes and the deletes that release them take turns, so neither undoes the other.
  const lock = yield* Semaphore.make(1);

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
  /**
   * A "new chat" firing rebound the task on its machine away from the thread the board last
   * bound: the node's chat follows it.
   */
  const adopt = Effect.fn("AgentSchedules.adopt")(function* (
    workflowId: string,
    nodeId: string,
    marker: Marker,
    task: ScheduledTask,
  ) {
    const threadId = task.threadId;
    const current = yield* findNode(workflowId, nodeId);
    if (threadId === null || threadId === (marker.threadId ?? current.node.chat?.threadId))
      return undefined;
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const node = yield* patchNode(workflowId, nodeId, (current) =>
      current.schedule?.taskId !== marker.taskId ||
      current.schedule.environmentId !== marker.environmentId
        ? current
        : {
            ...current,
            chat: {
              environmentId: marker.environmentId,
              projectId: task.projectId,
              threadId,
              startedAt,
            },
            schedule: { ...current.schedule, threadId },
          },
    );
    return node.chat;
  });
  const deleteTask = Effect.fn("AgentSchedules.deleteTask")(function* (marker: Marker) {
    const driver = yield* driverFor(marker.environmentId, "remove the schedule");
    yield* driver
      .deleteScheduledTask(marker)
      .pipe(Effect.mapError(unreachable("remove the schedule")));
  });
  const readTask = (
    driver: NodeDriver,
    marker: Pick<Marker, "environmentId" | "taskId">,
    action: string,
  ) => driver.getScheduledTask(marker).pipe(Effect.mapError(unreachable(action)));
  /** Binds the task to the node's chat, keeping its other settings. */
  const bindToChat = Effect.fn("AgentSchedules.bindToChat")(function* (
    workflowId: string,
    nodeId: string,
    driver: NodeDriver,
    marker: Marker,
    task: ScheduledTask,
    chat: Chat,
    settings: BoardNewNodeChatInput,
  ) {
    const input = upsertOf(task);
    if (!input)
      return yield* new BoardInternalError({
        message: "The agent's schedule was changed to a webhook in t3.",
      });
    yield* driver
      .upsertScheduledTask({
        environmentId: marker.environmentId,
        task: { ...input, projectId: chat.projectId, threadId: chat.threadId, ...settings },
      })
      .pipe(Effect.mapError(unreachable("move the schedule to the new chat")));
    const { rebind: _done, ...bound } = marker;
    yield* setMarker(workflowId, nodeId, { ...bound, threadId: chat.threadId });
  });

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
    const target = { environmentId: opened.environmentId, taskId: taskIdFor(workflowId, nodeId) };
    const driver = yield* driverFor(target.environmentId, "save the schedule");
    // Read before marking, so an unreachable machine leaves nothing behind.
    const existing = yield* readTask(driver, target, "save the schedule");
    const kept = node.schedule?.environmentId === target.environmentId ? node.schedule : undefined;
    const chat = (existing && kept && (yield* adopt(workflowId, nodeId, kept, existing))) || opened;
    const marker = { ...target, threadId: chat.threadId };
    // The marker goes before the write, so a save whose outcome is unknown can be cleaned up.
    yield* setMarker(workflowId, nodeId, marker);
    const plan = taskScheduleOf(input.timing, input.runs);
    const beforeRun = input.beforeRun === "none" ? null : input.beforeRun;
    const write = (runCount: number) =>
      driver
        .upsertScheduledTask({
          environmentId: marker.environmentId,
          task: {
            id: marker.taskId,
            title: `${node.name} · ${workflow.name}`,
            prompt: input.prompt,
            enabled: true,
            schedule: plan.schedule,
            startAt: plan.startAt ?? null,
            maxRuns: plan.runs === undefined ? null : runCount + plan.runs,
            beforeRun,
            projectId: chat.projectId,
            threadId: chat.threadId,
            workspaceStrategy: { type: "root" },
            modelSelection: existing?.modelSelection ?? node.modelSelection,
            runtimeMode: existing?.runtimeMode ?? node.runtimeMode ?? workflow.settings.runtimeMode,
            interactionMode: existing?.interactionMode ?? "default",
          },
        })
        .pipe(Effect.mapError(unreachable("save the schedule")));
    const first = yield* write(existing?.runCount ?? 0).pipe(
      Effect.tapError(() =>
        existing
          ? Effect.void
          : driver
              .deleteScheduledTask(marker)
              .pipe(Effect.andThen(setMarker(workflowId, nodeId, undefined)), Effect.ignore),
      ),
    );
    // A firing between the read and the write would eat into the runs just granted.
    const task =
      plan.runs !== undefined &&
      first.maxRuns !== undefined &&
      first.runCount !== (existing?.runCount ?? 0)
        ? yield* write(first.runCount)
        : first;
    // A published t3 drops the fields it does not know, so the task would not do what was asked.
    if (
      (plan.runs !== undefined && task.maxRuns === undefined) ||
      (plan.startAt !== undefined && task.startAt === undefined) ||
      (beforeRun !== null && task.beforeRun === undefined)
    ) {
      // The marker stays while the delete fails, so a later delete can still remove the task.
      yield* driver
        .deleteScheduledTask(marker)
        .pipe(Effect.andThen(setMarker(workflowId, nodeId, undefined)), Effect.ignore);
      return yield* new BoardInternalError({
        message:
          "The agent's machine runs a t3 without run limits, start times or chat preparation for schedules. Update it to the board's t3 build.",
      });
    }
    // A delete that ran while this save was writing found no task; this save removes it.
    const after = yield* store.getWorkflow(workflowId);
    const now = after?.nodes.find((entry) => entry.id === nodeId);
    if (
      now?.schedule?.taskId !== marker.taskId ||
      now.schedule.environmentId !== marker.environmentId
    ) {
      yield* driver.deleteScheduledTask(marker).pipe(Effect.ignore);
      return yield* new BoardNotFoundError({ message: "The agent was removed while scheduling." });
    }
    return now;
  }, lock.withPermit);

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
  }, lock.withPermit);

  /**
   * Brings the node's chat and its task back in step. A sync follows whichever side moved last;
   * a retarget ("/new") always binds the task to the chat the user just started.
   */
  const reconcile = Effect.fn("AgentSchedules.reconcile")(function* (
    workflowId: string,
    nodeId: string,
  ) {
    const { node } = yield* findNode(workflowId, nodeId);
    const marker = node.schedule;
    const settings = marker?.rebind;
    const chat = node.chat;
    if (!marker || !chat) return;
    if (marker.environmentId !== chat.environmentId) {
      yield* deleteTask(marker);
      yield* setMarker(workflowId, nodeId, undefined);
      return;
    }
    const driver = yield* driverFor(marker.environmentId, "read the schedule");
    const task = yield* readTask(driver, marker, "read the schedule");
    if (task === null) return;
    if (settings === undefined && task.threadId !== (marker.threadId ?? chat.threadId)) {
      yield* adopt(workflowId, nodeId, marker, task);
      return;
    }
    if (task.threadId !== chat.threadId || settings !== undefined)
      yield* bindToChat(workflowId, nodeId, driver, marker, task, chat, settings ?? {});
  });

  // The pending rebind is kept until the machine takes it, so a later sync finishes a failed "/new".
  const retarget = (workflowId: string, nodeId: string, settings: BoardNewNodeChatInput) =>
    lock.withPermit(
      patchNode(workflowId, nodeId, (current) =>
        current.schedule
          ? { ...current, schedule: { ...current.schedule, rebind: settings } }
          : current,
      ).pipe(Effect.andThen(reconcile(workflowId, nodeId))),
    );
  const sync = (workflowId: string, nodeId: string) =>
    lock.withPermit(reconcile(workflowId, nodeId));

  const release = Effect.fn("AgentSchedules.release")(function* (nodes: ReadonlyArray<BoardNode>) {
    const targets: Array<{ node: BoardNode; marker: Marker; driver: NodeDriver }> = [];
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
      targets.push({ node, marker, driver: driver.value });
    }
    const unreachableFor = (node: BoardNode) => (cause: NodeDriverError) =>
      new BoardInternalError({
        message: `Could not remove ${node.name}'s schedule from its machine: ${cause.message} Try again when the machine is online.`,
      });
    // Reach every machine first, so one that is offline does not leave the others half removed.
    for (const { node, marker, driver } of targets)
      yield* driver.getScheduledTask(marker).pipe(Effect.mapError(unreachableFor(node)));
    for (const { node, marker, driver } of targets)
      yield* driver.deleteScheduledTask(marker).pipe(Effect.mapError(unreachableFor(node)));
  });

  return AgentSchedules.of({
    save,
    setEnabled,
    remove,
    retarget,
    sync,
    release,
    exclusive: lock.withPermit,
  });
});

export const layer = Layer.effect(AgentSchedules, make);
