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
  type BoardDriverThread,
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
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import { forkParked } from "./upstream.ts";

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
    readonly startClaimed: (
      workflowId: string,
      input: BoardStartRunInput,
      claim: Effect.Effect<boolean, SqlError>,
    ) => Effect.Effect<RunRecord | undefined, EngineError>;
    readonly stop: (workflowId: string, runId: string) => Effect.Effect<RunRecord, EngineError>;
  }
>()("t3/board/TaskEngine") {}

const stableId = (taskId: string, purpose: string) =>
  `board:${createHash("sha256").update(taskId).update("\0").update(purpose).digest("hex")}`;
const MAX_FINISHED_RUNS = 50;
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
              const node = workflow?.nodes.find((entry) => entry.id === task.nodeId);
              const live =
                checkpoint.stage === "settle" ||
                (checkpoint.stage === "send" && checkpoint.attempted);
              if (live && node?.projectId) {
                interrupting = true;
                yield* store.putTask({
                  ...task,
                  status: "completing",
                  checkpoint: {
                    stage: "interrupt",
                    thread: {
                      environmentId: node.environmentId,
                      projectId: node.projectId,
                      threadId: node.threadId,
                    },
                    ...(checkpoint.stage === "settle" ? { runId: checkpoint.runId } : {}),
                  } satisfies Checkpoint,
                });
              } else {
                yield* store.putTask({ ...task, status: "stopped" });
              }
            }
            if (!workflow || !run || run.status !== "running") return { targets: selected, run };
            const at = yield* now;
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
      if (!task) return;
      if (task.status === "completing") {
        yield* lockFor(task.runId).withPermits(1)(interruptTask(task.id));
        return;
      }
      if (terminal(task.status)) return;
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
            const sent = yield* driver
              .send({
                thread: {
                  environmentId: node.environmentId,
                  projectId: node.projectId!,
                  threadId: node.threadId,
                },
                commandId: CommandId.make(stableId(task.id, `send:${checkpoint.step}`)),
                messageId,
                text: checkpoint.text,
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
              store.putTask({
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
  ) {
    const result = yield* store
      .transaction(
        Effect.gen(function* () {
          if (claim && !(yield* claim)) return undefined;
          const workflow = yield* store.getWorkflow(workflowId);
          if (!workflow) return yield* new BoardNotFoundError({ message: "Workflow not found." });
          if (yield* store.getTask(input.id)) {
            const existing = workflow.runs.find((entry) => entry.id === input.id);
            if (existing?.nodeId === input.nodeId && existing.task === input.task) return existing;
            return yield* new BoardConflictError({ message: "Run id already exists." });
          }
          const node = workflow.nodes.find((entry) => entry.id === input.nodeId);
          if (!node?.projectId)
            return yield* new BoardInvalidRequestError({
              message: "The entry node needs a project and thread.",
            });
          if (validateGraph(workflow).length)
            return yield* new BoardInvalidRequestError({
              message: "The workflow graph is invalid.",
            });
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
              if (task.status === "completing") yield* interruptTask(task.id);
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
  const startClaimed: TaskEngine["Service"]["startClaimed"] = Effect.fn("TaskEngine.startClaimed")(
    (workflowId, input, claim) => startWith(workflowId, input, claim),
  );
  return TaskEngine.of({ start, startClaimed, stop });
});

export const layer = Layer.effect(TaskEngine, make);
