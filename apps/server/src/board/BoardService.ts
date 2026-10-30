// @effect-diagnostics-next-line nodeBuiltinImport:off -- Folder project ids must be unique and derived synchronously.
import * as NodeCrypto from "node:crypto";
import {
  BoardConflictError,
  type BoardInternalError,
  type BoardMachineUnavailableError,
  BoardInvalidRequestError,
  BoardNotFoundError,
  createWorkflow,
  defaultFolder,
  validateGraph,
  withFolder,
  type BoardAddFolderInput,
  type BoardCreateNodeInput,
  type BoardCreateScheduleInput,
  type BoardCreateWorkflowInput,
  type BoardCreateWorkspaceInput,
  type BoardEdge,
  type BoardNode,
  type BoardPeer,
  type BoardSaveNodeScheduleInput,
  type BoardSchedule,
  type BoardNewNodeChatInput,
  type BoardStartRunInput,
  type BoardUpdateNodeInput,
  type BoardUpdateScheduleInput,
  type BoardUpdateWorkflowInput,
  type BoardUpdateWorkspaceInput,
  type GraphProblem,
  type KanbanCard,
  type NodeDriverError,
  type RunRecord,
  type Workflow,
  type Workspace,
  workspaceNameTaken,
} from "@t3tools/board-core";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";
import * as AgentSchedules from "./AgentSchedules.ts";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as TaskEngine from "./TaskEngine.ts";
import { boardNow, maxRunsAfter, nextBoardRunAt } from "./boardTiming.ts";

type BoardError =
  | SqlError
  | NodeDriverError
  | BoardNotFoundError
  | BoardInvalidRequestError
  | BoardConflictError
  | BoardInternalError
  | BoardMachineUnavailableError;
type Op<A> = Effect.Effect<A, BoardError>;
type EngineError = BoardError;

export class BoardService extends Context.Service<
  BoardService,
  {
    readonly listWorkspaces: () => Op<ReadonlyArray<Workspace>>;
    readonly getWorkspace: (id: string) => Op<Workspace>;
    readonly createWorkspace: (input: BoardCreateWorkspaceInput) => Op<Workspace>;
    readonly updateWorkspace: (id: string, input: BoardUpdateWorkspaceInput) => Op<Workspace>;
    readonly deleteWorkspace: (id: string) => Op<void>;
    readonly addFolder: (id: string, input: BoardAddFolderInput) => Op<Workspace>;
    readonly deleteFolder: (id: string, environmentId: EnvironmentId) => Op<Workspace>;
    readonly getKanban: (workflowId: string) => Op<ReadonlyArray<KanbanCard>>;
    readonly listWorkflows: () => Op<ReadonlyArray<Workflow>>;
    readonly getWorkflow: (id: string) => Op<Workflow>;
    readonly createWorkflow: (input: BoardCreateWorkflowInput) => Op<Workflow>;
    readonly updateWorkflow: (id: string, input: BoardUpdateWorkflowInput) => Op<Workflow>;
    readonly deleteWorkflow: (id: string) => Op<void>;
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
    readonly openNodeChat: (id: string, nodeId: string) => Effect.Effect<BoardNode, EngineError>;
    /** Moves the node to a fresh chat thread with its settings; the old thread stays in t3. */
    readonly newNodeChat: (
      id: string,
      nodeId: string,
      settings: BoardNewNodeChatInput,
    ) => Effect.Effect<BoardNode, EngineError>;
    readonly saveNodeSchedule: (
      id: string,
      nodeId: string,
      input: BoardSaveNodeScheduleInput,
    ) => Effect.Effect<BoardNode, EngineError>;
    readonly setNodeScheduleEnabled: (
      id: string,
      nodeId: string,
      enabled: boolean,
    ) => Effect.Effect<void, EngineError>;
    readonly deleteNodeSchedule: (id: string, nodeId: string) => Effect.Effect<void, EngineError>;
    readonly syncNodeSchedule: (id: string, nodeId: string) => Effect.Effect<void, EngineError>;
  }
>()("t3/board/BoardService") {}

const describeProblem = (problem: GraphProblem) => {
  switch (problem.kind) {
    case "several-orchestrators":
      return "A workflow has at most one orchestrator.";
    case "no-orchestrator":
      return "A workflow with workers needs an orchestrator.";
    default:
      return "The workflow graph is invalid.";
  }
};

const make = Effect.gen(function* () {
  const store = yield* BoardStore.BoardStore;
  const drivers = yield* DriverRegistry.DriverRegistry;
  const engine = yield* TaskEngine.TaskEngine;
  const schedules = yield* AgentSchedules.AgentSchedules;
  const getWorkflow = Effect.fn("BoardService.getWorkflow")(function* (id: string) {
    const workflow = yield* store.getWorkflow(id);
    if (!workflow) return yield* new BoardNotFoundError({ message: "Workflow not found." });
    return workflow;
  });
  const getWorkspace = Effect.fn("BoardService.getWorkspace")(function* (id: string) {
    const workspace = yield* store.getWorkspace(id);
    if (!workspace) return yield* new BoardNotFoundError({ message: "Workspace not found." });
    return workspace;
  });
  const saveWorkspace = Effect.fn("BoardService.saveWorkspace")(function* (workspace: Workspace) {
    yield* store.putWorkspace(workspace);
    yield* store.appendEvent({ kind: "workspace.upserted", workspace });
    return workspace;
  });
  const save = Effect.fn("BoardService.save")(function* (workflow: Workflow) {
    const [problem] = validateGraph(workflow);
    if (problem) return yield* new BoardInvalidRequestError({ message: describeProblem(problem) });
    yield* store.putWorkflow(workflow);
    yield* store.appendEvent({ kind: "workflow.upserted", workflow });
    return workflow;
  });
  const checkEditable = (workflow: Workflow) =>
    workflow.runs.some((run) => run.status === "running" || run.status === "stopping")
      ? Effect.fail(
          new BoardConflictError({ message: "Stop the active run before changing the workflow." }),
        )
      : Effect.void;
  const checkMachine = (environmentId: EnvironmentId) =>
    drivers
      .get(environmentId)
      .pipe(
        Effect.mapError(
          () => new BoardInvalidRequestError({ message: "That machine is not connected." }),
        ),
      );
  const checkWorkspaceName = Effect.fn("BoardService.checkWorkspaceName")(function* (
    name: string,
    ownId?: string,
  ) {
    if (workspaceNameTaken(yield* store.listWorkspaces(), name, ownId))
      return yield* new BoardConflictError({ message: "A workspace with that name exists." });
  });
  const removeProjects = Effect.fn("BoardService.removeProjects")(function* (
    workspace: Workspace,
    environmentId?: EnvironmentId,
  ) {
    for (const folder of workspace.folders) {
      if (
        !folder.managed ||
        (environmentId !== undefined && folder.environmentId !== environmentId)
      )
        continue;
      yield* drivers.get(folder.environmentId).pipe(
        Effect.flatMap((driver) =>
          driver.deleteProject({
            environmentId: folder.environmentId,
            projectId: folder.projectId,
            removeFolder: true,
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove a workspace project from its machine", {
            workspaceId: workspace.id,
            environmentId: folder.environmentId,
            cause,
          }),
        ),
      );
    }
  });
  const deleteSchedulesFor = Effect.fn("BoardService.deleteSchedulesFor")(function* (
    workflowId: string,
  ) {
    for (const schedule of yield* store.listSchedules()) {
      if (schedule.workflowId !== workflowId) continue;
      yield* store.deleteSchedule(schedule.id);
      yield* store.appendEvent({ kind: "schedule.deleted", scheduleId: schedule.id });
    }
  });

  const createWorkspace = Effect.fn("BoardService.createWorkspace")(function* (
    input: BoardCreateWorkspaceInput,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        if (yield* store.getWorkspace(input.id))
          return yield* new BoardConflictError({ message: "Workspace id already exists." });
        yield* checkWorkspaceName(input.name);
        return yield* saveWorkspace({ id: input.id, name: input.name, folders: [] });
      }),
    );
  });
  const updateWorkspace = Effect.fn("BoardService.updateWorkspace")(function* (
    id: string,
    input: BoardUpdateWorkspaceInput,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        const workspace = yield* getWorkspace(id);
        yield* checkWorkspaceName(input.name, id);
        return yield* saveWorkspace({ ...workspace, name: input.name });
      }),
    );
  });
  const addFolder = Effect.fn("BoardService.addFolder")(function* (
    id: string,
    input: BoardAddFolderInput,
  ) {
    yield* checkMachine(input.environmentId);
    return yield* store.transaction(
      Effect.gen(function* () {
        const workspace = yield* getWorkspace(id);
        if (workspace.folders.some((folder) => folder.environmentId === input.environmentId))
          return yield* new BoardConflictError({
            message: "The workspace already has a folder on that machine.",
          });
        const folder = defaultFolder(workspace, input.environmentId, NodeCrypto.randomUUID());
        return yield* saveWorkspace({
          ...workspace,
          folders: [
            ...workspace.folders,
            input.path === undefined ? folder : { ...folder, path: input.path },
          ],
        });
      }),
    );
  });
  const deleteFolder = Effect.fn("BoardService.deleteFolder")(function* (
    id: string,
    environmentId: EnvironmentId,
  ) {
    const removed = yield* store.transaction(
      Effect.gen(function* () {
        const workspace = yield* getWorkspace(id);
        if (!workspace.folders.some((folder) => folder.environmentId === environmentId))
          return yield* new BoardNotFoundError({ message: "Folder not found." });
        const inUse = (yield* store.listWorkflows()).some(
          (workflow) =>
            workflow.workspaceId === id &&
            workflow.nodes.some((node) => node.environmentId === environmentId),
        );
        if (inUse)
          return yield* new BoardConflictError({
            message: "Agents of this workspace still run on that machine.",
          });
        const next = yield* saveWorkspace({
          ...workspace,
          folders: workspace.folders.filter((folder) => folder.environmentId !== environmentId),
        });
        return { workspace, next };
      }),
    );
    yield* removeProjects(removed.workspace, environmentId);
    return removed.next;
  });
  const deleteWorkspace = Effect.fn("BoardService.deleteWorkspace")(function* (id: string) {
    const workspace = yield* getWorkspace(id);
    const workflows = (yield* store.listWorkflows()).filter(
      (workflow) => workflow.workspaceId === id,
    );
    for (const workflow of workflows) yield* checkEditable(workflow);
    yield* schedules.release(workflows.flatMap((workflow) => workflow.nodes));
    // Rows go first, in one transaction with the editable check, so no run can start while the
    // slow machine cleanup below runs.
    yield* store.transaction(
      Effect.gen(function* () {
        const current = (yield* store.listWorkflows()).filter(
          (workflow) => workflow.workspaceId === id,
        );
        for (const workflow of current) yield* checkEditable(workflow);
        for (const workflow of current) {
          yield* store.deleteRunTasks(workflow.runs.map((run) => run.id));
          yield* deleteSchedulesFor(workflow.id);
          yield* store.appendEvent({ kind: "workflow.deleted", workflowId: workflow.id });
        }
        yield* store.deleteWorkspace(id);
        yield* store.appendEvent({ kind: "workspace.deleted", workspaceId: id });
      }),
    );
    yield* removeProjects(workspace);
  }, schedules.exclusive);

  const create = Effect.fn("BoardService.createWorkflow")(function* (
    input: BoardCreateWorkflowInput,
  ) {
    return yield* store.transaction(
      Effect.gen(function* () {
        yield* getWorkspace(input.workspaceId);
        if (yield* store.getWorkflow(input.id))
          return yield* new BoardConflictError({ message: "Workflow id already exists." });
        return yield* save({
          ...createWorkflow(input.id, input.name, input.workspaceId),
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
    const workflow = yield* getWorkflow(id);
    yield* checkEditable(workflow);
    yield* schedules.release(workflow.nodes);
    yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        yield* checkEditable(workflow);
        yield* store.deleteRunTasks(workflow.runs.map((run) => run.id));
        yield* store.deleteWorkflow(id);
        yield* deleteSchedulesFor(id);
        yield* store.appendEvent({ kind: "workflow.deleted", workflowId: id });
      }),
    );
  }, schedules.exclusive);
  const ensureFolder = Effect.fn("BoardService.ensureFolder")(function* (
    workspaceId: string,
    environmentId: EnvironmentId,
  ) {
    const workspace = yield* getWorkspace(workspaceId);
    const next = withFolder(workspace, environmentId, NodeCrypto.randomUUID());
    if (next !== workspace) yield* saveWorkspace(next);
  });
  const createNode = Effect.fn("BoardService.createNode")(function* (
    id: string,
    input: BoardCreateNodeInput,
  ) {
    yield* checkMachine(input.environmentId);
    return yield* store.transaction(
      Effect.gen(function* () {
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
        const node: BoardNode = input;
        yield* ensureFolder(workflow.workspaceId, node.environmentId);
        yield* save({ ...workflow, nodes: [...workflow.nodes, node] });
        return node;
      }),
    );
  });
  const updateNode = Effect.fn("BoardService.updateNode")(function* (
    id: string,
    nodeId: string,
    input: BoardUpdateNodeInput,
  ) {
    if (input.environmentId !== undefined) yield* checkMachine(input.environmentId);
    const moves = (node: BoardNode) =>
      input.environmentId !== undefined && input.environmentId !== node.environmentId;
    const plan = Effect.fn("BoardService.planNodeUpdate")(function* (workflow: Workflow) {
      yield* checkEditable(workflow);
      const current = workflow.nodes.find((node) => node.id === nodeId);
      if (!current) return yield* new BoardNotFoundError({ message: "Node not found." });
      const { schedule: _released, ...unscheduled } = current;
      const node: BoardNode = { ...(moves(current) ? unscheduled : current), ...input };
      if (
        node.name !== current.name &&
        workflow.nodes.some(
          (entry) =>
            entry.id !== nodeId &&
            entry.name.trim().toLowerCase() === node.name.trim().toLowerCase(),
        )
      )
        return yield* new BoardConflictError({ message: "Node id or name already exists." });
      const next = {
        ...workflow,
        nodes: workflow.nodes.map((entry) => (entry.id === nodeId ? node : entry)),
      };
      const [problem] = validateGraph(next);
      if (problem)
        return yield* new BoardInvalidRequestError({ message: describeProblem(problem) });
      return { current, node, next };
    });
    // The schedule fires into the chat on the old machine, so it goes with a move that will pass.
    const planned = yield* plan(yield* getWorkflow(id));
    if (moves(planned.current)) yield* schedules.release([planned.current]);
    return yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        const { node, next } = yield* plan(workflow);
        yield* ensureFolder(workflow.workspaceId, node.environmentId);
        yield* save(next);
        return node;
      }),
    );
  }, schedules.exclusive);
  const deleteNode = Effect.fn("BoardService.deleteNode")(function* (id: string, nodeId: string) {
    const workflow = yield* getWorkflow(id);
    yield* checkEditable(workflow);
    yield* schedules.release(workflow.nodes.filter((node) => node.id === nodeId));
    yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        yield* checkEditable(workflow);
        if (!workflow.nodes.some((node) => node.id === nodeId))
          return yield* new BoardNotFoundError({ message: "Node not found." });
        for (const card of yield* store.listKanban(id)) {
          if (card.assigneeNodeId !== nodeId) continue;
          const { assigneeNodeId: _gone, ...unassigned } = card;
          yield* store.putCard(id, unassigned);
          yield* store.appendEvent({ kind: "kanban.upserted", workflowId: id, card: unassigned });
        }
        yield* save({
          ...workflow,
          nodes: workflow.nodes.filter((node) => node.id !== nodeId),
          edges: workflow.edges.filter((edge) => edge.a !== nodeId && edge.b !== nodeId),
          pending: workflow.pending.filter((entry) => entry.from !== nodeId && entry.to !== nodeId),
        });
      }),
    );
  }, schedules.exclusive);
  const createEdge = Effect.fn("BoardService.createEdge")(function* (id: string, edge: BoardEdge) {
    yield* store.transaction(
      Effect.gen(function* () {
        const workflow = yield* getWorkflow(id);
        yield* checkEditable(workflow);
        yield* save({ ...workflow, edges: [...workflow.edges, edge] });
      }),
    );
    return edge;
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
  const getKanban = Effect.fn("BoardService.getKanban")(function* (workflowId: string) {
    yield* getWorkflow(workflowId);
    return yield* store.listKanban(workflowId);
  });
  const findSchedule = Effect.fn("BoardService.findSchedule")(function* (id: string) {
    const schedule = (yield* store.listSchedules()).find((entry) => entry.id === id);
    if (!schedule) return yield* new BoardNotFoundError({ message: "Schedule not found." });
    return schedule;
  });
  const createSchedule = Effect.fn("BoardService.createSchedule")(function* (
    input: BoardCreateScheduleInput,
  ) {
    const now = yield* boardNow;
    return yield* store.transaction(
      Effect.gen(function* () {
        yield* getWorkflow(input.workflowId);
        if ((yield* store.listSchedules()).some((entry) => entry.id === input.id))
          return yield* new BoardConflictError({ message: "Schedule id already exists." });
        const { runs, ...rest } = input;
        const maxRuns = maxRunsAfter(input.timing, 0, runs);
        const unscheduled = { ...rest, runCount: 0, ...(maxRuns === undefined ? {} : { maxRuns }) };
        const schedule: BoardSchedule = {
          ...unscheduled,
          nextRunAt: nextBoardRunAt(unscheduled, now),
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
    const now = yield* boardNow;
    return yield* store.transaction(
      Effect.gen(function* () {
        const current = yield* findSchedule(id);
        const timing = input.timing ?? current.timing;
        const { maxRuns: _old, ...unlimited } = current;
        const maxRuns =
          input.runs === undefined && input.timing?.type !== "once"
            ? current.maxRuns
            : maxRunsAfter(timing, current.runCount, input.runs ?? undefined);
        const merged = {
          ...unlimited,
          ...(input.task === undefined ? {} : { task: input.task }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          timing,
          ...(maxRuns === undefined ? {} : { maxRuns }),
        };
        // Editing only the task keeps the due run; timing, limit or resuming restart the clock.
        const keep =
          input.timing === undefined &&
          input.runs === undefined &&
          merged.enabled === current.enabled &&
          current.nextRunAt !== null;
        const schedule: BoardSchedule = {
          ...merged,
          nextRunAt: keep ? current.nextRunAt : nextBoardRunAt(merged, now),
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
    listWorkspaces: store.listWorkspaces,
    getWorkspace,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    addFolder,
    deleteFolder,
    getKanban,
    listWorkflows: store.listWorkflows,
    getWorkflow,
    createWorkflow: create,
    updateWorkflow: update,
    deleteWorkflow: remove,
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
    openNodeChat: Effect.fn("BoardService.openNodeChat")(function* (id: string, nodeId: string) {
      return yield* engine.openNodeChat(id, nodeId);
    }),
    newNodeChat: Effect.fn("BoardService.newNodeChat")(function* (
      id: string,
      nodeId: string,
      settings: BoardNewNodeChatInput,
    ) {
      const node = yield* engine.openNodeChat(id, nodeId, settings);
      yield* schedules.retarget(id, nodeId, settings);
      return node;
    }),
    saveNodeSchedule: schedules.save,
    setNodeScheduleEnabled: schedules.setEnabled,
    deleteNodeSchedule: schedules.remove,
    syncNodeSchedule: schedules.sync,
  });
});

export const layer = Layer.effect(BoardService, make);
