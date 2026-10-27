// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stable IDs must be derived synchronously when constructing checkpoints.
import { createHash } from "node:crypto";
import {
  BoardConflictError,
  BoardInternalError,
  BoardInvalidRequestError,
  BoardNotFoundError,
  buildCorrectionMessage,
  buildRequestMessage,
  buildReturnMessage,
  buildStartMessage,
  decideRouting,
  parseResult,
  validateGraph,
  type BoardResult,
  type BoardStartRunInput,
  type NodeDriverError,
  type RunRecord,
  type RunRequestRecord,
  type Workflow,
} from "@t3tools/board-core";
import { CommandId, MessageId, type RunId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";
import { forkParked } from "../serverActivation.ts";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";

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
  | { readonly stage: "done"; readonly result: BoardResult };

export class TaskEngine extends Context.Service<
  TaskEngine,
  {
    readonly start: (
      workflowId: string,
      input: BoardStartRunInput,
    ) => Effect.Effect<RunRecord, EngineError>;
    readonly stop: (workflowId: string, runId: string) => Effect.Effect<RunRecord, EngineError>;
  }
>()("t3/board/TaskEngine") {}

const stableId = (taskId: string, purpose: string) =>
  `board:${createHash("sha256").update(taskId).update("\0").update(purpose).digest("hex")}`;
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const terminal = (status: BoardStore.TaskStatus) =>
  status === "done" || status === "failed" || status === "stopped";

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
  const saveRun = Effect.fn("TaskEngine.saveRun")(function* (
    workflow: import("@t3tools/board-core").Workflow,
    run: RunRecord,
  ) {
    yield* store.putWorkflow({
      ...workflow,
      runs: workflow.runs.map((entry) => (entry.id === run.id ? run : entry)),
    });
    yield* store.appendEvent({ kind: "run.upserted", workflowId: workflow.id, run });
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
      }),
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
            for (const task of selected.toReversed())
              yield* store.putTask({ ...task, status: "stopped" });
            const id = workflowId ?? selected[0]?.workflowId;
            const workflow = id === undefined ? undefined : yield* store.getWorkflow(id);
            const run = workflow?.runs.find((entry) => entry.id === runId);
            if (workflowId !== undefined && (!workflow || !run))
              return yield* new BoardNotFoundError({ message: "Run not found." });
            if (!workflow || !run || run.status !== "running") return { targets: selected, run };
            const at = yield* now;
            const updated: RunRecord = {
              ...run,
              ...(workflowId === undefined ? {} : { status: "stopped" as const, endedAt: at }),
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
        const workflows = new Map<string, Workflow>();
        let failure: NodeDriverError | undefined;
        for (const task of targets) {
          let workflow = workflows.get(task.workflowId);
          if (!workflow) {
            workflow = yield* store.getWorkflow(task.workflowId);
            if (workflow) workflows.set(task.workflowId, workflow);
          }
          const node = workflow?.nodes.find((entry) => entry.id === task.nodeId);
          if (!node?.projectId) continue;
          const checkpoint = task.checkpoint as Checkpoint;
          const result = yield* drivers.get(node.environmentId).pipe(
            Effect.flatMap((driver) =>
              driver.interrupt({
                thread: {
                  environmentId: node.environmentId,
                  projectId: node.projectId!,
                  threadId: node.threadId,
                },
                commandId: CommandId.make(stableId(task.id, "interrupt")),
                ...(checkpoint.stage === "settle" ? { runId: checkpoint.runId } : {}),
              }),
            ),
            Effect.result,
          );
          if (Result.isFailure(result)) {
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

  const process = Effect.fn("TaskEngine.process")(function* (
    taskId: string,
  ): Effect.fn.Return<
    void,
    SqlError | NodeDriverError | BoardInvalidRequestError | BoardNotFoundError
  > {
    while (true) {
      const task = yield* store.getTask(taskId);
      if (!task || terminal(task.status)) return;
      const workflow = yield* store.getWorkflow(task.workflowId);
      const run = workflow?.runs.find((entry) => entry.id === task.runId);
      const node = workflow?.nodes.find((entry) => entry.id === task.nodeId);
      if (!workflow || !run || run.status !== "running" || !node?.projectId) {
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
            const messageId = MessageId.make(stableId(task.id, `message:${checkpoint.step}`));
            const sent = yield* driver.send({
              thread: {
                environmentId: node.environmentId,
                projectId: node.projectId!,
                threadId: node.threadId,
              },
              commandId: CommandId.make(stableId(task.id, `send:${checkpoint.step}`)),
              messageId,
              text: checkpoint.text,
            });
            yield* store.transaction(
              store.putTask({
                ...current,
                status: "running",
                checkpoint: {
                  stage: "settle",
                  step: checkpoint.step,
                  corrected: checkpoint.corrected,
                  runId: sent.runId,
                  sequence: sent.sequence,
                  messageId,
                } satisfies Checkpoint,
              }),
            );
            return sent;
          }),
        );
        if (!outcome) return;
        continue;
      }
      if (checkpoint.stage === "settle") {
        const driver = yield* drivers.get(node.environmentId);
        const thread = {
          environmentId: node.environmentId,
          projectId: node.projectId,
          threadId: node.threadId,
        };
        const sequence = (yield* store.snapshot()).sequence;
        const current = yield* store.getTask(task.id);
        if (!current || terminal(current.status)) return;
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
        );
        if (Option.isNone(settled)) {
          const latest = yield* store.getTask(task.id);
          if (latest && !terminal(latest.status))
            yield* failTask(task.id, "The thread's settlement stream ended unexpectedly.");
          return;
        }
        if (settled.value.status !== "completed") {
          yield* failTask(task.id, `The thread ${settled.value.status}.`);
          return;
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
            ? decideRouting(result, { ...workflow, runs: [run] }, node.id)
            : undefined;
        if (decision && !decision.ok) reason = decision.reason;
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
                { ...currentWorkflow, runs: [currentRun] },
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
        const entries = run.requests.filter(
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
              Effect.andThen(failTask(id, "The board task failed.")),
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

  const start: TaskEngine["Service"]["start"] = Effect.fn("TaskEngine.start")(
    function* (workflowId, input) {
      const result = yield* store
        .transaction(
          Effect.gen(function* () {
            const workflow = yield* store.getWorkflow(workflowId);
            if (!workflow) return yield* new BoardNotFoundError({ message: "Workflow not found." });
            const node = workflow.nodes.find((entry) => entry.id === input.nodeId);
            if (!node?.projectId)
              return yield* new BoardInvalidRequestError({
                message: "The entry node needs a project and thread.",
              });
            if (validateGraph(workflow).length)
              return yield* new BoardInvalidRequestError({
                message: "The workflow graph is invalid.",
              });
            if (yield* store.getTask(input.id))
              return yield* new BoardConflictError({ message: "Run id already exists." });
            const run: RunRecord = {
              id: input.id,
              nodeId: node.id,
              nodeName: node.name,
              task: input.task,
              status: "running",
              startedAt: yield* now,
              requests: [],
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
            yield* store.putWorkflow({ ...workflow, runs: [...workflow.runs, run] });
            yield* store.appendEvent({ kind: "run.upserted", workflowId, run });
            return run;
          }),
        )
        .pipe(
          Effect.catchIf(
            (error) => error._tag === "SqlError",
            (cause) =>
              Effect.logError("Could not start board run", { cause }).pipe(
                Effect.andThen(
                  Effect.fail(new BoardInternalError({ message: "Could not start board run." })),
                ),
              ),
          ),
        );
      yield* spawn(input.id);
      return result;
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
      if (run.status !== "running") return run;
      const stopped = yield* stopTasks(runId, new Set(), workflowId).pipe(
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
      if (!stopped) return yield* new BoardNotFoundError({ message: "Run not found." });
      return stopped;
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
      for (const task of tasks) if (!terminal(task.status)) yield* spawn(task.id);
    }).pipe(Effect.catch((cause) => Effect.logError("Could not recover board tasks", { cause }))),
  );
  return TaskEngine.of({ start, stop });
});

export const layer = Layer.effect(TaskEngine, make);
