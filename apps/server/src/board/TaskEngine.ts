// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stable IDs must be derived synchronously when constructing checkpoints.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import {
  BoardConflictError,
  currentNodeThread,
  BoardInternalError,
  BoardInvalidRequestError,
  BoardNotFoundError,
  applyKanban,
  kanbanDuty,
  buildAgentInstructions,
  buildCorrectionMessage,
  buildKanbanBrief,
  buildRequestMessage,
  buildReturnMessage,
  buildSeededMessage,
  buildStartMessage,
  cardOfNode,
  connectedNodeNames,
  decideRouting,
  incomingNodeNames,
  mirrorPlan,
  moveCard,
  parseResult,
  type PlanStep,
  entryNodeOf,
  validateRunnable,
  withFolder,
  type BoardNode,
  type BoardResult,
  type BoardNewNodeChatInput,
  type BoardStartRunInput,
  type BoardDriverThread,
  type KanbanCard,
  type KanbanChange,
  type KanbanStatus,
  type NodeDriver,
  type NodeDriverError,
  type NodeThread,
  type RunRecord,
  type RunRequestRecord,
  type RunThread,
  type Workflow,
} from "@t3tools/board-core";
import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type RunId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import { forkParked } from "./upstream.ts";
import type { WorkspaceFolder } from "@t3tools/board-core/boardModel";
import { sharedFilesPath } from "@t3tools/board-core/sharedFiles";

type EngineError =
  | BoardNotFoundError
  | BoardConflictError
  | BoardInvalidRequestError
  | BoardInternalError;
type Checkpoint =
  | {
      readonly stage: "send";
      readonly step: number;
      readonly text: string;
      readonly corrected: boolean;
      /** Set after an uncertain send: the peer may be running it, so Stop must interrupt. */
      readonly attempted?: boolean;
    }
  | {
      readonly stage: "settle";
      readonly step: number;
      readonly corrected: boolean;
      readonly runId: RunId;
      readonly sequence: number;
      readonly messageId: MessageId;
    }
  | { readonly stage: "join"; readonly step: number; readonly denied: ReadonlyArray<string> }
  | { readonly stage: "interrupt"; readonly thread: BoardDriverThread; readonly runId?: RunId }
  | { readonly stage: "done"; readonly result: BoardResult };

export class TaskEngine extends Context.Service<
  TaskEngine,
  {
    readonly start: (
      workflowId: string,
      input: BoardStartRunInput,
    ) => Effect.Effect<RunRecord, EngineError>;
    /** With `continueRunsOf`, the run takes over the chats of the latest finished run with that id prefix. */
    readonly startClaimed: (
      workflowId: string,
      input: BoardStartRunInput,
      claim: Effect.Effect<boolean, SqlError>,
      options?: { readonly continueRunsOf?: string },
    ) => Effect.Effect<RunRecord | undefined, EngineError>;
    readonly stop: (workflowId: string, runId: string) => Effect.Effect<RunRecord, EngineError>;
    readonly openNodeChat: (
      workflowId: string,
      nodeId: string,
      fresh?: BoardNewNodeChatInput,
    ) => Effect.Effect<BoardNode, EngineError>;
    /** The workspace's folder on a machine, created and registered there when it has none yet. */
    readonly workspaceFolder: (
      workspaceId: string,
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      { readonly folder: WorkspaceFolder },
      BoardNotFoundError | NodeDriverError | SqlError
    >;
  }
>()("t3/board/TaskEngine") {}

const stableId = (taskId: string, purpose: string) =>
  `board:${NodeCrypto.createHash("sha256").update(taskId).update("\0").update(purpose).digest("hex")}`;
const MAX_FINISHED_RUNS = 50;
/** The workflow as the run saw it when it started: routing and prompts never follow later edits. */
const runWorkflow = (workflow: Workflow, run: RunRecord): Workflow => ({
  ...workflow,
  ...run.definition,
  runs: [run],
});
/**
 * The chats of the latest finished run whose id starts with `prefix`, for the nodes still on the
 * same machine. They are seeded again, since compaction may have folded the instructions away.
 */
const carriedThreads = (workflow: Workflow, prefix: string): RunRecord["threads"] => {
  const previous = workflow.runs
    .filter((run) => run.id.startsWith(prefix) && !isActive(run))
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!previous) return {};
  return Object.fromEntries(
    workflow.nodes.flatMap((node) => {
      const thread = previous.threads[node.id];
      return thread && thread.environmentId === node.environmentId
        ? [[node.id, { ...thread, seeded: false }]]
        : [];
    }),
  );
};
const threadOf = (run: RunRecord, nodeId: string): BoardDriverThread | undefined => {
  const thread = run.threads[nodeId];
  return (
    thread && {
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      threadId: thread.threadId,
    }
  );
};
const isActive = (run: RunRecord) => run.status === "running" || run.status === "stopping";
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const terminal = (status: BoardStore.TaskStatus) =>
  status === "done" || status === "failed" || status === "stopped" || status === "completing";

const make = Effect.gen(function* () {
  const store = yield* BoardStore.BoardStore;
  const drivers = yield* DriverRegistry.DriverRegistry;
  const scope = yield* Effect.scope;
  const running = yield* Ref.make<ReadonlySet<string>>(new Set());
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (id: string) => {
    const existing = locks.get(id);
    if (existing) return existing;
    const lock = Semaphore.makeUnsafe(1);
    locks.set(id, lock);
    return lock;
  };
  const saveRun = Effect.fn("TaskEngine.saveRun")(function* (workflow: Workflow, run: RunRecord) {
    yield* store.putWorkflow({
      ...workflow,
      runs: workflow.runs.map((entry) => (entry.id === run.id ? run : entry)),
    });
    yield* store.appendEvent({
      kind: "run.upserted",
      workflowId: workflow.id,
      run,
      pending: workflow.pending,
    });
  });

  const writeCards = Effect.fn("TaskEngine.writeCards")(function* (
    workflowId: string,
    change: Pick<KanbanChange, "upserted" | "deleted">,
  ) {
    for (const card of change.upserted) {
      yield* store.putCard(workflowId, card);
      yield* store.appendEvent({ kind: "kanban.upserted", workflowId, card });
    }
    for (const cardId of change.deleted) {
      yield* store.deleteCard(workflowId, cardId);
      yield* store.appendEvent({ kind: "kanban.deleted", workflowId, cardId });
    }
  });
  /**
   * Moves the worker's assigned card and returns its id ("" when none moved). With a `cardId` (the card
   * chosen when the task began) only that card moves; otherwise the first status group with a card wins.
   */
  const moveWorkerCard = Effect.fn("TaskEngine.moveWorkerCard")(function* (
    workflowId: string,
    node: BoardNode | undefined,
    groups: ReadonlyArray<ReadonlyArray<KanbanStatus>>,
    to: KanbanStatus,
    reason?: string,
    cardId?: string,
  ) {
    if (node?.profile !== "worker") return "";
    const cards = yield* store.listKanban(workflowId);
    const card =
      cardId === undefined
        ? groups
            .map((statuses) => cardOfNode(cards, node.id, statuses))
            .find((entry): entry is KanbanCard => entry !== undefined)
        : cards.find((entry) => entry.id === cardId);
    if (!card) return "";
    yield* writeCards(workflowId, {
      upserted: [moveCard(card, to, yield* now, reason)],
      deleted: [],
    });
    return card.id;
  });
  /** Checks the orchestrator's kanban operations against the cards; a reason means they do not fit. */
  const kanbanProblem = Effect.fn("TaskEngine.kanbanProblem")(function* (
    workflow: Workflow,
    node: BoardNode,
    result: BoardResult,
    finishingRun: boolean,
  ) {
    if (node.profile !== "orchestrator") return undefined;
    let pending = 0;
    const applied = applyKanban({
      cards: yield* store.listKanban(workflow.id),
      ops: result.kanban ?? [],
      nodes: workflow.nodes,
      actor: node.id,
      at: yield* now,
      runId: workflow.runs[0]?.id,
      newId: () => `pending-${(pending += 1)}`,
    });
    if (!applied.ok) return `kanban: ${applied.reason}`;
    const requested =
      result.routing.kind === "request"
        ? result.routing.requests.flatMap((request) => {
            const target = workflow.nodes.find(
              (entry) => entry.name.trim().toLowerCase() === request.to.trim().toLowerCase(),
            );
            return target?.profile === "worker" ? [target] : [];
          })
        : [];
    return kanbanDuty({
      cards: applied.value.cards,
      requested,
      finishingRun: finishingRun && result.routing.kind === "finish",
      runId: workflow.runs[0]?.id,
    });
  });
  /** Shows the orchestrator's to-do list on the kanban while its task is still running. */
  const mirrorTodoList = Effect.fn("TaskEngine.mirrorTodoList")(function* (
    task: BoardStore.BoardTask,
    node: BoardNode,
    steps: ReadonlyArray<PlanStep>,
  ) {
    yield* store.transaction(
      Effect.gen(function* () {
        const current = yield* store.getTask(task.id);
        if (!current || terminal(current.status)) return;
        yield* writeCards(
          task.workflowId,
          mirrorPlan({
            cards: yield* store.listKanban(task.workflowId),
            steps,
            runId: task.runId,
            actor: node.id,
            at: yield* now,
          }),
        );
      }),
    );
  });
  const commitKanban = Effect.fn("TaskEngine.commitKanban")(function* (
    workflow: Workflow,
    node: BoardNode,
    result: BoardResult,
  ) {
    if (!result.kanban?.length) return;
    if (node.profile !== "orchestrator") {
      yield* Effect.logWarning(
        "A worker tried to change the board kanban; only the orchestrator may.",
        {
          workflowId: workflow.id,
          nodeId: node.id,
        },
      );
      return;
    }
    const applied = applyKanban({
      cards: yield* store.listKanban(workflow.id),
      ops: result.kanban,
      nodes: workflow.nodes,
      actor: node.id,
      at: yield* now,
      runId: workflow.runs[0]?.id,
      newId: () => NodeCrypto.randomUUID(),
    });
    if (!applied.ok) {
      yield* Effect.logWarning("Board kanban operations no longer fit the cards.", {
        workflowId: workflow.id,
        reason: applied.reason,
      });
      return;
    }
    yield* writeCards(workflow.id, applied.value);
  });

  const failTask = Effect.fn("TaskEngine.failTask")(function* (taskId: string, reason: string) {
    yield* store.transaction(
      Effect.gen(function* () {
        const task = yield* store.getTask(taskId);
        if (!task || terminal(task.status)) return;
        const workflow = yield* store.getWorkflow(task.workflowId);
        const run = workflow?.runs.find((entry) => entry.id === task.runId);
        yield* store.putTask({ ...task, status: "failed" });
        if (!workflow || !run || run.status !== "running") return;
        const endedAt = yield* now;
        const updated: RunRecord =
          task.kind === "run"
            ? { ...run, status: "failed", endedAt, summary: reason }
            : {
                ...run,
                requests: run.requests.map((entry) =>
                  entry.id === task.id
                    ? { ...entry, status: "failed", failureReason: reason, returnedAt: endedAt }
                    : entry,
                ),
              };
        yield* saveRun(
          { ...workflow, pending: workflow.pending.filter((entry) => entry.id !== task.id) },
          updated,
        );
        yield* moveWorkerCard(
          workflow.id,
          run.definition.nodes.find((entry) => entry.id === task.nodeId),
          [["doing"], ["todo", "blocked", "waiting_for_human"]],
          "blocked",
          reason,
          task.cardId,
        );
      }),
    );
  });

  const interruptTask = Effect.fn("TaskEngine.interruptTask")(function* (taskId: string) {
    const task = yield* store.getTask(taskId);
    if (!task || task.status !== "completing") return;
    const checkpoint = task.checkpoint as Checkpoint;
    if (checkpoint.stage !== "interrupt") return;
    const driver = yield* drivers.get(checkpoint.thread.environmentId);
    yield* driver.interrupt({
      thread: checkpoint.thread,
      ...(checkpoint.runId ? { runId: checkpoint.runId } : {}),
      commandId: CommandId.make(stableId(task.id, "interrupt")),
    });
    yield* store.transaction(
      Effect.gen(function* () {
        const current = yield* store.getTask(taskId);
        if (!current || current.status !== "completing") return;
        yield* store.putTask({ ...current, status: "stopped" });
        const workflow = yield* store.getWorkflow(task.workflowId);
        const run = workflow?.runs.find((entry) => entry.id === task.runId);
        if (!workflow || !run) return;
        const interrupting = (yield* store.listTasks(task.runId)).some(
          (entry) => entry.status === "completing",
        );
        if (run.status === "stopping" && !interrupting)
          yield* saveRun(workflow, { ...run, status: "stopped", endedAt: yield* now });
        else yield* store.appendEvent({ kind: "run.upserted", workflowId: workflow.id, run });
      }),
    );
  });

  const retrying = new Set<string>();
  /** Retries an interrupt every second while the machine is away; it may be continuing the turn. */
  const keepInterrupting = (task: BoardStore.BoardTask) =>
    lockFor(task.runId)
      .withPermits(1)(interruptTask(task.id))
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "NodeDriverError" && error.retryable === true,
          schedule: Schedule.spaced("1 second"),
        }),
      );
  const retryInBackground = (task: BoardStore.BoardTask) =>
    Effect.suspend(() => {
      if (retrying.has(task.id)) return Effect.void;
      retrying.add(task.id);
      return keepInterrupting(task).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Could not interrupt board task", { taskId: task.id, cause }),
        ),
        Effect.ensuring(Effect.sync(() => retrying.delete(task.id))),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

  const stopTasks = Effect.fn("TaskEngine.stopTasks")(function* (
    runId: string,
    ids: ReadonlySet<string>,
    workflowId?: string,
  ) {
    return yield* lockFor(runId).withPermits(1)(
      Effect.gen(function* () {
        const { targets, run: stoppedRun } = yield* store.transaction(
          Effect.gen(function* () {
            const all = yield* store.listTasks(runId);
            const stoppedIds =
              workflowId === undefined ? new Set(ids) : new Set(all.map((task) => task.id));
            let changed = true;
            while (changed) {
              changed = false;
              for (const task of all)
                if (task.owner && stoppedIds.has(task.owner) && !stoppedIds.has(task.id)) {
                  stoppedIds.add(task.id);
                  changed = true;
                }
            }
            const selected = all.filter(
              (task) => stoppedIds.has(task.id) && !terminal(task.status),
            );
            const id = workflowId ?? selected[0]?.workflowId;
            const workflow = id === undefined ? undefined : yield* store.getWorkflow(id);
            const run = workflow?.runs.find((entry) => entry.id === runId);
            if (workflowId !== undefined && (!workflow || !run))
              return yield* new BoardNotFoundError({ message: "Run not found." });
            let interrupting = false;
            for (const task of selected.toReversed()) {
              const checkpoint = task.checkpoint as Checkpoint;
              const thread = run && threadOf(run, task.nodeId);
              // Each run has its own threads, so interrupting a launched node thread never touches other work.
              const live = checkpoint.stage === "settle" || checkpoint.stage === "send";
              if (live && thread) {
                interrupting = true;
                yield* store.putTask({
                  ...task,
                  status: "completing",
                  checkpoint: {
                    stage: "interrupt",
                    thread,
                    ...(checkpoint.stage === "settle" ? { runId: checkpoint.runId } : {}),
                  } satisfies Checkpoint,
                });
              } else {
                yield* store.putTask({ ...task, status: "stopped" });
              }
              const node = run?.definition.nodes.find((entry) => entry.id === task.nodeId);
              const card =
                task.cardId === undefined
                  ? undefined
                  : (yield* store.listKanban(task.workflowId)).find(
                      (entry) => entry.id === task.cardId,
                    );
              if (node && card?.status === "doing" && card.assigneeNodeId === task.nodeId)
                yield* moveWorkerCard(
                  task.workflowId,
                  node,
                  [["doing"]],
                  "blocked",
                  workflowId === undefined
                    ? "Stopped because a sibling request failed."
                    : "Stopped by user.",
                  task.cardId,
                );
            }
            if (!workflow || !run || run.status !== "running") return { targets: selected, run };
            const at = yield* now;
            if (workflowId !== undefined) {
              const waiting = (yield* store.listKanban(workflow.id)).filter(
                (card) => card.runId === runId && card.status === "todo",
              );
              if (waiting.length > 0)
                yield* writeCards(workflow.id, {
                  upserted: waiting.map((card) =>
                    moveCard(card, "blocked", at, "Stopped by user."),
                  ),
                  deleted: [],
                });
            }
            const updated: RunRecord = {
              ...run,
              ...(workflowId === undefined
                ? {}
                : interrupting
                  ? { status: "stopping" as const }
                  : { status: "stopped" as const, endedAt: at }),
              requests: run.requests.map((entry) =>
                entry.status === "pending" && stoppedIds.has(entry.id)
                  ? { ...entry, status: "stopped", returnedAt: at }
                  : entry,
              ),
            };
            yield* saveRun(
              {
                ...workflow,
                pending: workflow.pending.filter((entry) => !stoppedIds.has(entry.id)),
              },
              updated,
            );
            return { targets: selected, run: updated };
          }),
        );
        let failure: NodeDriverError | undefined;
        for (const task of targets.toReversed()) {
          const result = yield* interruptTask(task.id).pipe(Effect.result);
          if (Result.isFailure(result)) {
            if (result.failure._tag === "SqlError") return yield* result.failure;
            if (result.failure.retryable) {
              yield* retryInBackground(task);
              continue;
            }
            failure ??= result.failure;
            yield* Effect.logWarning("Could not interrupt board task", {
              taskId: task.id,
              cause: result.failure,
            });
          }
        }
        if (failure) return yield* failure;
        return stoppedRun;
      }),
    );
  });

  /** The workspace's folder on a machine, registered there as a t3 project. */
  const workspaceFolder = Effect.fn("TaskEngine.workspaceFolder")(function* (
    workspaceId: string,
    environmentId: EnvironmentId,
  ) {
    const workspace = yield* store.getWorkspace(workspaceId);
    if (!workspace) return yield* new BoardNotFoundError({ message: "Workspace not found." });
    const withFolders = withFolder(workspace, environmentId, NodeCrypto.randomUUID());
    if (withFolders !== workspace)
      yield* store.transaction(
        Effect.gen(function* () {
          yield* store.putWorkspace(withFolders);
          yield* store.appendEvent({ kind: "workspace.upserted", workspace: withFolders });
        }),
      );
    const folder = withFolders.folders.find((entry) => entry.environmentId === environmentId)!;
    const driver = yield* drivers.get(environmentId);
    const { adopted } = yield* driver.ensureProject({
      environmentId,
      projectId: folder.projectId,
      title: workspace.name,
      path: folder.path,
    });
    if (adopted && folder.managed) {
      const kept = {
        ...withFolders,
        folders: withFolders.folders.map((entry) =>
          entry === folder ? { ...entry, managed: false } : entry,
        ),
      };
      yield* store.transaction(
        Effect.gen(function* () {
          yield* store.putWorkspace(kept);
          yield* store.appendEvent({ kind: "workspace.upserted", workspace: kept });
        }),
      );
    }
    return { folder, driver };
  });

  /**
   * The node's own chat outside runs: one thread per node and machine, launched on first open.
   * A fresh one ("/new") replaces it with a new thread, launched with the settings it brings.
   */
  const openNodeChat = Effect.fn("TaskEngine.openNodeChat")(
    function* (workflowId: string, nodeId: string, fresh?: BoardNewNodeChatInput) {
      const workflow = yield* store.getWorkflow(workflowId);
      const node = workflow?.nodes.find((entry) => entry.id === nodeId);
      if (!workflow || !node) return yield* new BoardNotFoundError({ message: "Node not found." });
      if (!fresh && node.chat?.environmentId === node.environmentId) return node;
      const { folder, driver } = yield* workspaceFolder(workflow.workspaceId, node.environmentId);
      const key = `chat\0${workflowId}\0${node.id}\0${node.environmentId}${fresh ? `\0${NodeCrypto.randomUUID()}` : ""}`;
      const threadId = ThreadId.make(stableId(key, "thread"));
      yield* driver.launch({
        environmentId: node.environmentId,
        launch: {
          commandId: CommandId.make(stableId(key, "launch")),
          threadId,
          projectId: folder.projectId,
          title: `${node.name} · ${workflow.name}`,
          modelSelection: fresh?.modelSelection ?? node.modelSelection,
          runtimeMode: fresh?.runtimeMode ?? node.runtimeMode ?? workflow.settings.runtimeMode,
          interactionMode: fresh?.interactionMode ?? "default",
          workspaceStrategy: { type: "root" },
        },
      });
      const chat = {
        environmentId: node.environmentId,
        projectId: folder.projectId,
        threadId,
        ...(fresh ? { startedAt: yield* now } : {}),
      };
      const before = currentNodeThread(workflow, nodeId);
      // A fresh chat always becomes the node's chat, so its tabs move before the board shows it.
      if (fresh) yield* carryTabs(driver, before, chat);
      const opened = yield* store.transaction(
        Effect.gen(function* () {
          const current = yield* store.getWorkflow(workflowId);
          const currentNode = current?.nodes.find((entry) => entry.id === nodeId);
          if (!current || !currentNode)
            return yield* new BoardNotFoundError({ message: "Node not found." });
          // A first open that finishes after another viewer's open or "/new" keeps their chat.
          if (!fresh && currentNode.chat?.environmentId === currentNode.environmentId)
            return currentNode;
          if (currentNode.environmentId !== node.environmentId)
            return yield* new BoardInvalidRequestError({
              message: "The agent moved to another machine while its chat started. Try again.",
            });
          const next = { ...currentNode, chat };
          const saved = {
            ...current,
            nodes: current.nodes.map((entry) => (entry.id === nodeId ? next : entry)),
          };
          yield* store.putWorkflow(saved);
          yield* store.appendEvent({ kind: "workflow.upserted", workflow: saved });
          return next;
        }),
      );
      if (!fresh && opened.chat?.threadId === threadId) yield* carryTabs(driver, before, chat);
      return opened;
    },
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.logError("Could not open board node chat", { cause }).pipe(
          Effect.andThen(
            Effect.fail(new BoardInternalError({ message: "Could not open the chat." })),
          ),
        ),
      NodeDriverError: (cause) =>
        Effect.fail(
          new BoardInternalError({ message: `Could not open the chat: ${cause.message}` }),
        ),
    }),
  );

  /** The agent's new thread takes over the browser tabs of the one it showed before, on the same machine. */
  const carryTabs = (
    driver: NodeDriver,
    from: NodeThread | undefined,
    to: Pick<NodeThread, "environmentId" | "threadId">,
  ) =>
    from && from.environmentId === to.environmentId && from.threadId !== to.threadId
      ? driver
          .carryBrowserTabs({
            environmentId: to.environmentId,
            from: from.threadId,
            to: to.threadId,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not move the agent's browser tabs to its new chat", {
                cause,
              }),
            ),
          )
      : Effect.void;

  /** Launches the node's fresh thread in the workspace folder on its machine, once per run. */
  const prepareThread = Effect.fn("TaskEngine.prepareThread")(function* (
    workflowId: string,
    runId: string,
    node: BoardNode,
  ) {
    const workflow = yield* store.getWorkflow(workflowId);
    const run = workflow?.runs.find((entry) => entry.id === runId);
    if (!workflow || !run) return yield* new BoardNotFoundError({ message: "Run not found." });
    const existing = run.threads[node.id];
    if (existing) return existing;
    const { folder, driver } = yield* workspaceFolder(workflow.workspaceId, node.environmentId);
    const key = `${runId}\0${node.id}`;
    const threadId = ThreadId.make(stableId(key, "thread"));
    yield* driver.launch({
      environmentId: node.environmentId,
      launch: {
        commandId: CommandId.make(stableId(key, "launch")),
        // A fixed thread and command id make a retried launch idempotent through t3's command receipts.
        threadId,
        projectId: folder.projectId,
        title: `${node.name} · ${workflow.name}`,
        modelSelection: node.modelSelection,
        runtimeMode: node.runtimeMode ?? run.definition.settings.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      },
    });
    const thread: RunThread = {
      environmentId: node.environmentId,
      projectId: folder.projectId,
      threadId,
      seeded: false,
    };
    // Before the board shows the new thread, so a browser window on the board never goes empty.
    yield* carryTabs(driver, currentNodeThread(workflow, node.id), thread);
    yield* store.transaction(
      Effect.gen(function* () {
        const current = yield* store.getWorkflow(workflowId);
        const currentRun = current?.runs.find((entry) => entry.id === runId);
        if (current && currentRun)
          yield* saveRun(current, {
            ...currentRun,
            threads: { ...currentRun.threads, [node.id]: thread },
          });
      }),
    );
    return thread;
  });
  const seedInstructions = Effect.fn("TaskEngine.seedInstructions")(function* (
    workflow: Workflow,
    node: BoardNode,
  ) {
    const peer = yield* store.getPeer(node.environmentId);
    const sharedFolder = (yield* store.getWorkspace(workflow.workspaceId))?.folders.find(
      (folder) => folder.environmentId === node.environmentId,
    );
    const sharedNames = (yield* store.listWorkspaceFiles(workflow.workspaceId)).map(
      (file) => file.name,
    );
    return buildAgentInstructions({
      name: node.name,
      profile: node.profile,
      machine: peer?.name ?? NodeOS.hostname(),
      ...(sharedFolder
        ? { sharedFiles: { folder: sharedFilesPath(sharedFolder.path), names: sharedNames } }
        : {}),
      prompt: node.prompt,
      outgoing: connectedNodeNames(workflow.nodes, workflow.edges, node.id),
      incoming: incomingNodeNames(workflow.nodes, workflow.edges, node.id),
      nodeNames: workflow.nodes.map((entry) => entry.name),
      ...(node.profile === "orchestrator" ? { kanban: yield* store.listKanban(workflow.id) } : {}),
    });
  });

  const process = Effect.fn("TaskEngine.process")(function* (
    taskId: string,
  ): Effect.fn.Return<
    void,
    SqlError | NodeDriverError | BoardInvalidRequestError | BoardNotFoundError
  > {
    while (true) {
      const task = yield* store.getTask(taskId);
      if (!task) return;
      if (task.status === "completing") {
        yield* keepInterrupting(task);
        return;
      }
      if (terminal(task.status)) return;
      const workflow = yield* store.getWorkflow(task.workflowId);
      const run = workflow?.runs.find((entry) => entry.id === task.runId);
      const node = run?.definition.nodes.find((entry) => entry.id === task.nodeId);
      if (!workflow || !run || run.status !== "running" || !node) {
        yield* failTask(task.id, "The workflow or its thread is no longer available.");
        return;
      }
      const checkpoint = task.checkpoint as Checkpoint;
      if (checkpoint.stage === "send") {
        const outcome = yield* lockFor(task.runId).withPermits(1)(
          Effect.gen(function* () {
            const current = yield* store.getTask(task.id);
            if (!current || terminal(current.status)) return null;
            const driver = yield* drivers.get(node.environmentId);
            const prepared = yield* prepareThread(task.workflowId, task.runId, node).pipe(
              Effect.result,
            );
            if (Result.isFailure(prepared)) {
              if (prepared.failure._tag !== "NodeDriverError") return yield* prepared.failure;
              return prepared.failure;
            }
            const thread = prepared.success;
            const messageId = MessageId.make(stableId(task.id, `message:${checkpoint.step}`));
            const text = thread.seeded
              ? node.profile === "orchestrator"
                ? [checkpoint.text, buildKanbanBrief(yield* store.listKanban(task.workflowId))]
                    .filter((part) => part !== "")
                    .join("\n\n")
                : checkpoint.text
              : buildSeededMessage(
                  yield* seedInstructions(runWorkflow(workflow, run), node),
                  checkpoint.text,
                );
            const sent = yield* driver
              .send({
                thread: {
                  environmentId: thread.environmentId,
                  projectId: thread.projectId,
                  threadId: thread.threadId,
                },
                commandId: CommandId.make(stableId(task.id, `send:${checkpoint.step}`)),
                messageId,
                text,
              })
              .pipe(Effect.result);
            if (Result.isFailure(sent)) {
              if (sent.failure.retryable && !checkpoint.attempted)
                yield* store.transaction(
                  store.putTask({ ...current, checkpoint: { ...checkpoint, attempted: true } }),
                );
              return sent.failure;
            }
            yield* store.transaction(
              Effect.gen(function* () {
                yield* store.putTask({
                  ...current,
                  status: "running",
                  checkpoint: {
                    stage: "settle",
                    step: checkpoint.step,
                    corrected: checkpoint.corrected,
                    runId: sent.success.runId,
                    sequence: sent.success.sequence,
                    messageId,
                  } satisfies Checkpoint,
                });
                if (thread.seeded) return;
                const latest = yield* store.getWorkflow(task.workflowId);
                const latestRun = latest?.runs.find((entry) => entry.id === task.runId);
                if (latest && latestRun)
                  yield* saveRun(latest, {
                    ...latestRun,
                    threads: { ...latestRun.threads, [node.id]: { ...thread, seeded: true } },
                  });
              }),
            );
            return sent.success;
          }),
        );
        if (!outcome) return;
        if ("_tag" in outcome) {
          if (!outcome.retryable) {
            yield* failTask(task.id, outcome.message);
            return;
          }
          // The peer may have accepted the message; resending with the same ids reconciles it.
          yield* Effect.logWarning("Board send is uncertain; retrying.", { taskId: task.id });
          yield* Effect.sleep("15 seconds");
        }
        continue;
      }
      if (checkpoint.stage === "settle") {
        const driver = yield* drivers.get(node.environmentId);
        const thread = threadOf(run, node.id);
        if (!thread) {
          yield* failTask(task.id, "The node's thread is no longer available.");
          return;
        }
        const sequence = (yield* store.snapshot()).sequence;
        const current = yield* store.getTask(task.id);
        if (!current || terminal(current.status)) return;
        // Best effort while the turn runs; the list as the turn left it is mirrored after it settles.
        const liveTodoList =
          node.profile === "orchestrator"
            ? driver.subscribePlans({ thread, afterSequence: checkpoint.sequence }).pipe(
                Stream.runForEach((steps) => mirrorTodoList(task, node, steps)),
                Effect.catch((cause) =>
                  Effect.logWarning("Board could not follow the orchestrator's to-do list.", {
                    taskId: task.id,
                    cause,
                  }),
                ),
                Effect.andThen(Effect.never),
              )
            : Effect.never;
        const settled = yield* Effect.raceFirst(
          driver.subscribeSettled({ thread, afterSequence: checkpoint.sequence }).pipe(
            Stream.filter((event) => event.messageId === checkpoint.messageId),
            Stream.runHead,
          ),
          store.events(sequence).pipe(
            Stream.filter((event) => event.kind === "run.upserted" && event.run.id === task.runId),
            Stream.mapEffect(() => store.getTask(task.id)),
            Stream.filter((entry) => !entry || terminal(entry.status)),
            Stream.runHead,
            Effect.as(Option.none()),
          ),
        ).pipe(Effect.raceFirst(liveTodoList));
        if (Option.isNone(settled)) {
          const latest = yield* store.getTask(task.id);
          if (latest?.status === "completing") continue;
          if (latest && !terminal(latest.status))
            yield* failTask(task.id, "The thread's settlement stream ended unexpectedly.");
          return;
        }
        if (settled.value.status !== "completed") {
          yield* failTask(task.id, `The thread ${settled.value.status}.`);
          return;
        }
        if (node.profile === "orchestrator") {
          const steps = yield* driver.readPlan({ thread, runId: settled.value.runId }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Board could not read the orchestrator's to-do list.", {
                taskId: task.id,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (steps) yield* mirrorTodoList(task, node, steps);
        }
        const message = yield* driver.readLatestAssistant({ thread, runId: settled.value.runId });
        const parsed = parseResult(message?.text ?? "");
        let reason: string | undefined = parsed.ok ? undefined : parsed.reason;
        const result = parsed.ok ? parsed.result : undefined;
        if (
          result?.routing.kind === "return" &&
          (task.kind !== "request" ||
            (result.routing.requestId !== undefined && result.routing.requestId !== task.id))
        ) {
          reason = "The return does not match this request.";
        }
        const decision =
          result?.routing.kind === "request"
            ? decideRouting(result, runWorkflow(workflow, run), node.id)
            : undefined;
        if (decision && !decision.ok) reason = decision.reason;
        if (reason === undefined && result)
          reason = yield* kanbanProblem(
            runWorkflow(workflow, run),
            node,
            result,
            task.kind === "run",
          );
        if (reason !== undefined || result === undefined) {
          if (checkpoint.corrected) {
            yield* failTask(
              task.id,
              `The thread did not provide a valid board result: ${reason ?? "missing result"}.`,
            );
            return;
          }
          yield* store.transaction(
            Effect.gen(function* () {
              const current = yield* store.getTask(task.id);
              if (current && !terminal(current.status))
                yield* store.putTask({
                  ...current,
                  status: "pending",
                  checkpoint: {
                    stage: "send",
                    step: checkpoint.step + 1,
                    text: buildCorrectionMessage(reason ?? "missing result"),
                    corrected: true,
                  } satisfies Checkpoint,
                });
            }),
          );
          continue;
        }
        if (decision?.ok) {
          const children = yield* store.transaction(
            Effect.gen(function* () {
              const current = yield* store.getTask(task.id);
              const currentWorkflow = yield* store.getWorkflow(task.workflowId);
              const currentRun = currentWorkflow?.runs.find((entry) => entry.id === task.runId);
              if (
                !current ||
                terminal(current.status) ||
                !currentWorkflow ||
                !currentRun ||
                currentRun.status !== "running"
              )
                return [];
              const freshDecision = decideRouting(
                result,
                runWorkflow(currentWorkflow, currentRun),
                node.id,
              );
              if (!freshDecision.ok)
                return yield* new BoardInvalidRequestError({ message: freshDecision.reason });
              const at = yield* now;
              const additions: RunRequestRecord[] = [];
              const created: BoardStore.BoardTask[] = [];
              const denied: string[] = [];
              const pending = [...currentWorkflow.pending];
              for (const [index, action] of freshDecision.actions.entries()) {
                if (action.kind !== "request" && action.kind !== "denied") continue;
                const id = stableId(task.id, `child:${checkpoint.step}:${index}`);
                additions.push({
                  id,
                  fromId: node.id,
                  toId: action.target.id,
                  from: node.name,
                  to: action.target.name,
                  at,
                  task: action.request.task,
                  ...(action.request.input === undefined ? {} : { input: action.request.input }),
                  status: action.kind === "denied" ? "denied" : "pending",
                  ...(action.kind === "denied"
                    ? { failureReason: `Handoff limit ${action.limit} reached.`, returnedAt: at }
                    : {}),
                });
                if (action.kind === "denied") {
                  denied.push(id);
                  continue;
                }
                pending.push({ id, from: node.id, to: action.target.id });
                const child: BoardStore.BoardTask = {
                  id,
                  workflowId: task.workflowId,
                  runId: task.runId,
                  kind: "request",
                  owner: task.id,
                  nodeId: action.target.id,
                  status: "pending",
                  waitOn: [],
                  waitPolicy: task.waitPolicy,
                  checkpoint: {
                    stage: "send",
                    step: 0,
                    corrected: false,
                    text: buildRequestMessage({
                      requestId: id,
                      from: node.name,
                      task: action.request.task,
                      ...(action.request.input === undefined
                        ? {}
                        : { input: action.request.input }),
                    }),
                  } satisfies Checkpoint,
                };
                yield* store.putTask(child);
                created.push(child);
              }
              yield* store.putTask({
                ...current,
                status: "waiting",
                waitOn: created.map((entry) => entry.id),
                checkpoint: { stage: "join", step: checkpoint.step, denied } satisfies Checkpoint,
              });
              yield* saveRun(
                { ...currentWorkflow, pending },
                { ...currentRun, requests: [...currentRun.requests, ...additions] },
              );
              yield* commitKanban(runWorkflow(currentWorkflow, currentRun), node, result);
              for (const entry of additions.filter((addition) => addition.status === "denied"))
                yield* moveWorkerCard(
                  task.workflowId,
                  currentRun.definition.nodes.find((candidate) => candidate.id === entry.toId),
                  [["todo", "doing"]],
                  "blocked",
                  entry.failureReason,
                );
              for (const child of created) {
                const cardId = yield* moveWorkerCard(
                  task.workflowId,
                  currentRun.definition.nodes.find((entry) => entry.id === child.nodeId),
                  [["todo", "blocked", "waiting_for_human"]],
                  "doing",
                );
                yield* store.putTask({ ...child, cardId });
              }
              return created;
            }),
          );
          for (const child of children) yield* spawn(child.id);
          continue;
        }
        yield* store.transaction(
          Effect.gen(function* () {
            const current = yield* store.getTask(task.id);
            const currentWorkflow = yield* store.getWorkflow(task.workflowId);
            const currentRun = currentWorkflow?.runs.find((entry) => entry.id === task.runId);
            if (
              !current ||
              terminal(current.status) ||
              !currentWorkflow ||
              !currentRun ||
              currentRun.status !== "running"
            )
              return;
            const at = yield* now;
            yield* store.putTask({
              ...current,
              status: "done",
              checkpoint: { stage: "done", result } satisfies Checkpoint,
            });
            const updated: RunRecord =
              task.kind === "run"
                ? {
                    ...currentRun,
                    status: "finished",
                    endedAt: at,
                    summary: result.summary,
                    data: result.data,
                  }
                : {
                    ...currentRun,
                    requests: currentRun.requests.map((entry) =>
                      entry.id === task.id
                        ? {
                            ...entry,
                            status: "returned",
                            returnedAt: at,
                            returnSummary: result.summary,
                            returnData: result.data,
                          }
                        : entry,
                    ),
                  };
            yield* saveRun(
              {
                ...currentWorkflow,
                pending: currentWorkflow.pending.filter((entry) => entry.id !== task.id),
              },
              updated,
            );
            yield* commitKanban(runWorkflow(currentWorkflow, currentRun), node, result);
            if (task.kind === "request")
              yield* moveWorkerCard(
                task.workflowId,
                node,
                [["doing"], ["todo", "blocked", "waiting_for_human"]],
                "done",
                undefined,
                current.cardId,
              );
          }),
        );
        return;
      }
      if (checkpoint.stage === "join") {
        const sequence = (yield* store.snapshot()).sequence;
        const children = (yield* store.listTasks(task.runId)).filter((entry) =>
          task.waitOn.includes(entry.id),
        );
        if (
          task.waitPolicy === "failFast" &&
          children.some((entry) => entry.status === "failed" || entry.status === "stopped")
        ) {
          const ids = new Set(children.map((entry) => entry.id));
          yield* stopTasks(task.runId, ids);
          yield* failTask(task.id, "A child request failed.");
          return;
        }
        if (
          children.length !== task.waitOn.length ||
          children.some((entry) => !terminal(entry.status))
        ) {
          yield* store.events(sequence).pipe(Stream.runHead);
          continue;
        }
        const joinedWorkflow = yield* store.getWorkflow(task.workflowId);
        const joinedRun = joinedWorkflow?.runs.find((entry) => entry.id === task.runId);
        if (!joinedRun) {
          yield* failTask(task.id, "The workflow run is no longer available.");
          return;
        }
        const entries = joinedRun.requests.filter(
          (entry) => task.waitOn.includes(entry.id) || checkpoint.denied.includes(entry.id),
        );
        const text = entries
          .map((entry) =>
            buildReturnMessage({
              requestId: entry.id,
              from: entry.to,
              summary: entry.returnSummary ?? entry.failureReason ?? entry.status,
              data: entry.returnData ?? null,
            }),
          )
          .join("\n\n");
        yield* store.transaction(
          Effect.gen(function* () {
            const current = yield* store.getTask(task.id);
            if (current && !terminal(current.status))
              yield* store.putTask({
                ...current,
                status: "pending",
                waitOn: [],
                checkpoint: {
                  stage: "send",
                  step: checkpoint.step + 1,
                  text,
                  corrected: false,
                } satisfies Checkpoint,
              });
          }),
        );
        continue;
      }
      return;
    }
  });

  const spawn: (id: string) => Effect.Effect<void> = Effect.fn("TaskEngine.spawn")(function* (
    id: string,
  ) {
    const added = yield* Ref.modify(running, (current) =>
      current.has(id) ? ([false, current] as const) : ([true, new Set([...current, id])] as const),
    );
    if (!added) return;
    yield* process(id).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("Board task failed", { taskId: id, cause }).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const task = yield* store.getTask(id);
                  if (task?.status !== "completing") yield* failTask(id, "The board task failed.");
                }),
              ),
              Effect.catch((error) =>
                Effect.logError("Could not persist board task failure", {
                  taskId: id,
                  cause: error,
                }),
              ),
            ),
      ),
      Effect.ensuring(
        Ref.update(running, (current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  const startWith = Effect.fn("TaskEngine.start")(function* (
    workflowId: string,
    input: BoardStartRunInput,
    claim?: Effect.Effect<boolean, SqlError>,
    continueRunsOf?: string,
  ) {
    const result = yield* store
      .transaction(
        Effect.gen(function* () {
          if (claim && !(yield* claim)) return undefined;
          const workflow = yield* store.getWorkflow(workflowId);
          if (!workflow) return yield* new BoardNotFoundError({ message: "Workflow not found." });
          if (yield* store.getTask(input.id)) {
            const existing = workflow.runs.find((entry) => entry.id === input.id);
            if (existing?.task === input.task) return existing;
            return yield* new BoardConflictError({ message: "Run id already exists." });
          }
          const [problem] = validateRunnable(workflow);
          if (problem)
            return yield* new BoardInvalidRequestError({
              message:
                problem.kind === "no-orchestrator"
                  ? "A workflow with workers needs an orchestrator."
                  : problem.kind === "several-orchestrators"
                    ? "A workflow has at most one orchestrator."
                    : "The workflow graph is invalid.",
            });
          const node = entryNodeOf(workflow.nodes);
          if (!node)
            return yield* new BoardInvalidRequestError({
              message: "Add an orchestrator to run this workflow.",
            });
          const run: RunRecord = {
            id: input.id,
            nodeId: node.id,
            nodeName: node.name,
            task: input.task,
            status: "running",
            startedAt: yield* now,
            requests: [],
            threads: continueRunsOf === undefined ? {} : carriedThreads(workflow, continueRunsOf),
            definition: {
              nodes: workflow.nodes,
              edges: workflow.edges,
              settings: workflow.settings,
            },
            ...(continueRunsOf === undefined ? {} : { compactAfter: true }),
          };
          const task: BoardStore.BoardTask = {
            id: input.id,
            workflowId,
            runId: input.id,
            kind: "run",
            owner: null,
            nodeId: node.id,
            status: "pending",
            waitOn: [],
            waitPolicy: workflow.settings.waitPolicy ?? "allSettled",
            checkpoint: {
              stage: "send",
              step: 0,
              text: buildStartMessage(input.id, input.task),
              corrected: false,
            } satisfies Checkpoint,
          };
          yield* store.putTask(task);
          let excess = workflow.runs.filter((entry) => !isActive(entry)).length - MAX_FINISHED_RUNS;
          const runs = [...workflow.runs, run].filter((entry) => isActive(entry) || excess-- <= 0);
          const next = { ...workflow, runs };
          yield* store.putWorkflow(next);
          if (runs.length !== workflow.runs.length + 1) {
            const kept = new Set(runs.map((entry) => entry.id));
            yield* store.deleteRunTasks(
              workflow.runs.filter((entry) => !kept.has(entry.id)).map((entry) => entry.id),
            );
            yield* store.appendEvent({ kind: "workflow.upserted", workflow: next });
          }
          yield* store.appendEvent({ kind: "run.upserted", workflowId, run });
          const cardId = yield* moveWorkerCard(
            workflowId,
            node,
            [["todo", "blocked", "waiting_for_human"]],
            "doing",
          );
          yield* store.putTask({ ...task, cardId });
          return run;
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.logError("Could not start board run", { cause }).pipe(
              Effect.andThen(
                Effect.fail(new BoardInternalError({ message: "Could not start board run." })),
              ),
            ),
        }),
      );
    if (result) yield* spawn(input.id);
    return result;
  });
  const start: TaskEngine["Service"]["start"] = Effect.fn("TaskEngine.start")(
    function* (workflowId, input) {
      return (yield* startWith(workflowId, input))!;
    },
  );

  const stop: TaskEngine["Service"]["stop"] = Effect.fn("TaskEngine.stop")(
    function* (workflowId, runId) {
      const workflow = yield* store
        .getWorkflow(workflowId)
        .pipe(
          Effect.mapError(() => new BoardInternalError({ message: "Could not load board run." })),
        );
      const run = workflow?.runs.find((entry) => entry.id === runId);
      if (!workflow || !run) return yield* new BoardNotFoundError({ message: "Run not found." });
      if (!isActive(run) && run.status !== "stopped") return run;
      const reload = (id: string) =>
        store
          .getWorkflow(workflowId)
          .pipe(Effect.map((w) => w?.runs.find((entry) => entry.id === id)));
      const retryInterrupts = (id: string) =>
        lockFor(id).withPermits(1)(
          Effect.gen(function* () {
            for (const task of yield* store.listTasks(id))
              if (task.status === "completing")
                yield* interruptTask(task.id).pipe(
                  Effect.catchIf(
                    (error) => error._tag === "NodeDriverError" && error.retryable === true,
                    () => retryInBackground(task),
                  ),
                );
            return yield* reload(id);
          }),
        );
      const targets = workflow.runs.filter((entry) => entry.id === runId || isActive(entry));
      const own = yield* Effect.gen(function* () {
        const results = yield* Effect.forEach(
          targets,
          (target) =>
            (target.status === "running"
              ? stopTasks(target.id, new Set(), workflowId).pipe(Effect.andThen(reload(target.id)))
              : retryInterrupts(target.id)
            ).pipe(Effect.result),
          { concurrency: 1 },
        );
        let found: RunRecord | undefined;
        for (const [index, result] of results.entries()) {
          if (Result.isFailure(result)) return yield* result.failure;
          if (targets[index]!.id === runId) found = result.success;
        }
        return found;
      }).pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.logError("Could not stop board run", { runId, cause }).pipe(
              Effect.andThen(
                Effect.fail(new BoardInternalError({ message: "Could not stop board run." })),
              ),
            ),
          NodeDriverError: (cause) =>
            Effect.logError("Could not interrupt board run", { runId, cause }).pipe(
              Effect.andThen(
                Effect.fail(new BoardInternalError({ message: "Could not interrupt board run." })),
              ),
            ),
        }),
      );
      if (!own) return yield* new BoardNotFoundError({ message: "Run not found." });
      return own;
    },
  );

  yield* forkParked(
    Effect.gen(function* () {
      const tasks = yield* store.listTasks();
      yield* store.transaction(
        Effect.forEach(
          tasks.filter((task) => task.status === "running"),
          (task) => store.putTask({ ...task, status: "pending" }),
          { discard: true },
        ),
      );
      for (const task of tasks)
        if (task.status === "completing" || !terminal(task.status)) yield* spawn(task.id);
    }).pipe(Effect.catch((cause) => Effect.logError("Could not recover board tasks", { cause }))),
  );
  yield* forkParked(
    store.listTasks().pipe(
      Effect.flatMap((tasks) =>
        Effect.forEach(
          tasks.filter((task) => task.status === "completing"),
          (task) => spawn(task.id),
          { discard: true },
        ),
      ),
      Effect.catch((cause) => Effect.logError("Could not retry board stops", { cause })),
      Effect.repeat(Schedule.spaced("30 seconds")),
    ),
  );
  /** Queues /compact in each chat of an ended run whose chats carry into the schedule's next run. */
  const compacted = new Set<string>();
  const compactRunChats = Effect.fn("TaskEngine.compactRunChats")(function* (run: RunRecord) {
    if (!run.compactAfter || isActive(run) || compacted.has(run.id)) return;
    compacted.add(run.id);
    for (const [nodeId, thread] of Object.entries(run.threads)) {
      const key = `${run.id}\0${nodeId}\0compact`;
      yield* drivers.get(thread.environmentId).pipe(
        Effect.flatMap((driver) =>
          driver.send({
            thread,
            // Fixed ids: a repeat after a restart is the same command to t3.
            commandId: CommandId.make(stableId(key, "command")),
            messageId: MessageId.make(stableId(key, "message")),
            text: IDLE_COMPACTION_TEXT,
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Could not compact a scheduled run's chat", {
            runId: run.id,
            nodeId,
            cause,
          }),
        ),
      );
    }
  });
  yield* forkParked(
    Effect.gen(function* () {
      const { sequence } = yield* store.snapshot();
      for (const workflow of yield* store.listWorkflows())
        for (const run of workflow.runs) yield* compactRunChats(run);
      yield* store
        .events(sequence)
        .pipe(
          Stream.runForEach((event) =>
            event.kind === "run.upserted" ? compactRunChats(event.run) : Effect.void,
          ),
        );
    }).pipe(Effect.catch((cause) => Effect.logError("Board run compaction stopped", { cause }))),
  );
  const startClaimed: TaskEngine["Service"]["startClaimed"] = Effect.fn("TaskEngine.startClaimed")(
    (workflowId, input, claim, options) =>
      startWith(workflowId, input, claim, options?.continueRunsOf),
  );
  return TaskEngine.of({ start, startClaimed, stop, openNodeChat, workspaceFolder });
});

export const layer = Layer.effect(TaskEngine, make);
