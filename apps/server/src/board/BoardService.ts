import {
  BoardConflictError,
  BoardInvalidRequestError,
  BoardNotFoundError,
  buildAgentFirstPrompt,
  createWorkflow,
  validateGraph,
  type BoardCreateNodeInput,
  type BoardCreateScheduleInput,
  type BoardCreateWorkflowInput,
  type BoardEdge,
  type BoardImportWorkflowsInput,
  type BoardNode,
  type BoardPeer,
  type BoardSchedule,
  type BoardStartRunInput,
  type BoardUpdateNodeInput,
  type BoardUpdateScheduleInput,
  type BoardUpdateWorkflowInput,
  type NodeDriverError,
  type RunRecord,
  type Workflow,
} from "@t3tools/board-core";
import { CommandId, MessageId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as TaskEngine from "./TaskEngine.ts";

type BoardError =
  | SqlError
  | NodeDriverError
  | BoardNotFoundError
  | BoardInvalidRequestError
  | BoardConflictError;
type Op<A> = Effect.Effect<A, BoardError>;
type EngineError = BoardError | import("@t3tools/board-core").BoardInternalError;

export class BoardService extends Context.Service<
  BoardService,
  {
    readonly listWorkflows: () => Op<ReadonlyArray<Workflow>>;
    readonly getWorkflow: (id: string) => Op<Workflow>;
    readonly createWorkflow: (input: BoardCreateWorkflowInput) => Op<Workflow>;
    readonly updateWorkflow: (id: string, input: BoardUpdateWorkflowInput) => Op<Workflow>;
    readonly deleteWorkflow: (id: string) => Op<void>;
    readonly importWorkflows: (input: BoardImportWorkflowsInput) => Op<ReadonlyArray<Workflow>>;
    readonly createNode: (id: string, input: BoardCreateNodeInput) => Op<BoardNode>;
    readonly updateNode: (id: string, nodeId: string, input: BoardUpdateNodeInput) => Op<BoardNode>;
    readonly deleteNode: (id: string, nodeId: string) => Op<void>;
    readonly createEdge: (id: string, edge: BoardEdge) => Op<BoardEdge>;
    readonly deleteEdge: (id: string, from: string, to: string) => Op<void>;
    readonly listPeers: () => Op<ReadonlyArray<BoardPeer>>;
    readonly listSchedules: () => Op<ReadonlyArray<BoardSchedule>>;
    readonly createSchedule: (input: BoardCreateScheduleInput) => Op<BoardSchedule>;
    readonly updateSchedule: (id: string, input: BoardUpdateScheduleInput) => Op<BoardSchedule>;
    readonly deleteSchedule: (id: string) => Op<void>;
    readonly startRun: (
      id: string,
      input: BoardStartRunInput,
    ) => Effect.Effect<RunRecord, EngineError>;
    readonly stopRun: (id: string, runId: string) => Effect.Effect<RunRecord, EngineError>;
  }
>()("t3/board/BoardService") {}

const make = Effect.gen(function* () {
  const store = yield* BoardStore.BoardStore;
  const drivers = yield* DriverRegistry.DriverRegistry;
  const engine = yield* TaskEngine.TaskEngine;
  const getWorkflow = Effect.fn("BoardService.getWorkflow")(function* (id: string) {
    const workflow = yield* store.getWorkflow(id);
    if (!workflow) return yield* new BoardNotFoundError({ message: "Workflow not found." });
    return workflow;
  });
  const save = Effect.fn("BoardService.save")(function* (workflow: Workflow) {
    if (validateGraph(workflow).length)
      return yield* new BoardInvalidRequestError({ message: "The workflow graph is invalid." });
    yield* store.putWorkflow(workflow);
    yield* store.appendEvent({ kind: "workflow.upserted", workflow });
    return workflow;
  });
  const checkEditable = (workflow: Workflow) =>
    workflow.runs.some((run) => run.status === "running")
      ? Effect.fail(
          new BoardConflictError({ message: "Stop the active run before changing the workflow." }),
        )
      : Effect.void;
  const create = Effect.fn("BoardService.createWorkflow")(function* (
    input: BoardCreateWorkflowInput,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        if (yield* store.getWorkflow(input.id))
          return yield* new BoardConflictError({ message: "Workflow id already exists." });
        return yield* save({
          ...createWorkflow(input.id, input.name),
          ...(input.settings === undefined ? {} : { settings: input.settings }),
        });
      }),
    );
  });
  const update = Effect.fn("BoardService.updateWorkflow")(function* (
    id: string,
    input: BoardUpdateWorkflowInput,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        yield* checkEditable(workflow);
        return yield* save({ ...workflow, ...input });
      }),
    );
  });
  const remove = Effect.fn("BoardService.deleteWorkflow")(function* (id: string) {
    yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        yield* checkEditable(workflow);
        yield* store.deleteWorkflow(id);
        yield* store.appendEvent({ kind: "workflow.deleted", workflowId: id });
      }),
    );
  });
  const importWorkflows = Effect.fn("BoardService.importWorkflows")(function* (
    input: BoardImportWorkflowsInput,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        const imported: Workflow[] = [];
        for (const workflow of input.workflows) {
          if (yield* store.getWorkflow(workflow.id)) continue;
          const safe = {
            ...workflow,
            pending: [],
            runQueue: [],
            runs: workflow.runs.map((run) =>
              run.status === "running" ? { ...run, status: "stopped" as const } : run,
            ),
          };
          imported.push(yield* save(safe));
        }
        return imported;
      }),
    );
  });
  const createNode = Effect.fn("BoardService.createNode")(function* (
    id: string,
    input: BoardCreateNodeInput,
  ) {
    const workflow = yield* getWorkflow(id);
    yield* checkEditable(workflow);
    if (
      workflow.nodes.some(
        (node) =>
          node.id === input.id ||
          node.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
      )
    )
      return yield* new BoardConflictError({ message: "Node id or name already exists." });
    if (input.kind === "launch") {
      const driver = yield* drivers.get(input.environmentId);
      const key = `${encodeURIComponent(id)}:${encodeURIComponent(input.id)}`;
      yield* driver.launch({
        environmentId: input.environmentId,
        launch: {
          commandId: CommandId.make(`board:launch:${key}`),
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.name,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          workspaceStrategy: input.workspaceStrategy,
          initialMessage: {
            messageId: MessageId.make(`board:briefing:${key}`),
            text: buildAgentFirstPrompt(input.name, input.role ?? "", [], []),
            attachments: [],
          },
        },
      });
    }
    const node: BoardNode = {
      id: input.id,
      name: input.name,
      environmentId: input.environmentId,
      projectId: input.projectId,
      threadId: input.threadId,
      x: input.x,
      y: input.y,
      baselined: true,
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.kind === "launch" ? { awaitingFirstReply: true } : {}),
    };
    return yield* store.transaction(
      Effect.gen(function* () {
        const current = yield* getWorkflow(id);
        yield* checkEditable(current);
        if (current.nodes.some((entry) => entry.id === node.id))
          return yield* new BoardConflictError({ message: "Node id already exists." });
        yield* save({ ...current, nodes: [...current.nodes, node] });
        return node;
      }),
    );
  });
  const updateNode = Effect.fn("BoardService.updateNode")(function* (
    id: string,
    nodeId: string,
    input: BoardUpdateNodeInput,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        yield* checkEditable(workflow);
        const current = workflow.nodes.find((node) => node.id === nodeId);
        if (!current) return yield* new BoardNotFoundError({ message: "Node not found." });
        const node = { ...current, ...input };
        yield* save({
          ...workflow,
          nodes: workflow.nodes.map((entry) => (entry.id === nodeId ? node : entry)),
        });
        return node;
      }),
    );
  });
  const deleteNode = Effect.fn("BoardService.deleteNode")(function* (id: string, nodeId: string) {
    yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        yield* checkEditable(workflow);
        if (!workflow.nodes.some((node) => node.id === nodeId))
          return yield* new BoardNotFoundError({ message: "Node not found." });
        yield* save({
          ...workflow,
          nodes: workflow.nodes.filter((node) => node.id !== nodeId),
          edges: workflow.edges.filter((edge) => edge.a !== nodeId && edge.b !== nodeId),
          pending: workflow.pending.filter((entry) => entry.from !== nodeId && entry.to !== nodeId),
        });
      }),
    );
  });
  const createEdge = Effect.fn("BoardService.createEdge")(function* (id: string, edge: BoardEdge) {
    return yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        yield* checkEditable(workflow);
        yield* save({ ...workflow, edges: [...workflow.edges, edge] });
        return edge;
      }),
    );
  });
  const deleteEdge = Effect.fn("BoardService.deleteEdge")(function* (
    id: string,
    from: string,
    to: string,
  ) {
    yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        yield* checkEditable(workflow);
        if (!workflow.edges.some((edge) => edge.a === from && edge.b === to))
          return yield* new BoardNotFoundError({ message: "Edge not found." });
        yield* save({
          ...workflow,
          edges: workflow.edges.filter((edge) => edge.a !== from || edge.b !== to),
        });
      }),
    );
  });
  const findSchedule = Effect.fn("BoardService.findSchedule")(function* (id: string) {
    const schedule = (yield* store.listSchedules()).find((entry) => entry.id === id);
    if (!schedule) return yield* new BoardNotFoundError({ message: "Schedule not found." });
    return schedule;
  });
  const nextRun = Effect.fn("BoardService.nextRun")(function* (everyMs: number) {
    const timestamp = yield* DateTime.now;
    return DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(timestamp) + everyMs));
  });
  const createSchedule = Effect.fn("BoardService.createSchedule")(function* (
    input: BoardCreateScheduleInput,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(input.workflowId);
        if (!workflow.nodes.some((node) => node.id === input.nodeId))
          return yield* new BoardInvalidRequestError({ message: "Schedule node not found." });
        if ((yield* store.listSchedules()).some((entry) => entry.id === input.id))
          return yield* new BoardConflictError({ message: "Schedule id already exists." });
        const schedule: BoardSchedule = {
          ...input,
          nextRunAt: input.enabled ? yield* nextRun(input.everyMs) : null,
        };
        yield* store.putSchedule(schedule);
        yield* store.appendEvent({ kind: "schedule.upserted", schedule });
        return schedule;
      }),
    );
  });
  const updateSchedule = Effect.fn("BoardService.updateSchedule")(function* (
    id: string,
    input: BoardUpdateScheduleInput,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        const current = yield* findSchedule(id);
        const workflow = yield* getWorkflow(current.workflowId);
        if (input.nodeId !== undefined && !workflow.nodes.some((node) => node.id === input.nodeId))
          return yield* new BoardInvalidRequestError({ message: "Schedule node not found." });
        const merged = { ...current, ...input };
        const schedule: BoardSchedule = {
          ...merged,
          nextRunAt: !merged.enabled
            ? null
            : !current.enabled || input.everyMs !== undefined
              ? yield* nextRun(merged.everyMs)
              : current.nextRunAt,
        };
        yield* store.putSchedule(schedule);
        yield* store.appendEvent({ kind: "schedule.upserted", schedule });
        return schedule;
      }),
    );
  });
  const deleteSchedule = Effect.fn("BoardService.deleteSchedule")(function* (id: string) {
    yield* store.transaction(
      Effect.gen(function* () {
        yield* findSchedule(id);
        yield* store.deleteSchedule(id);
        yield* store.appendEvent({ kind: "schedule.deleted", scheduleId: id });
      }),
    );
  });
  return BoardService.of({
    listWorkflows: store.listWorkflows,
    getWorkflow,
    createWorkflow: create,
    updateWorkflow: update,
    deleteWorkflow: remove,
    importWorkflows,
    createNode,
    updateNode,
    deleteNode,
    createEdge,
    deleteEdge,
    listPeers: store.listPeers,
    listSchedules: store.listSchedules,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    startRun: engine.start,
    stopRun: engine.stop,
  });
});

export const layer = Layer.effect(BoardService, make);
