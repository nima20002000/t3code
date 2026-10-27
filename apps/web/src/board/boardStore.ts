import { useSyncExternalStore } from "react";

import { randomUUID } from "../lib/utils";
import {
  MAX_LOG,
  MAX_RUNS,
  applySnapshot,
  createHistory,
  createWorkflow,
  discardHistory,
  migrateBoards,
  recordHistory,
  redoHistory,
  snapshotOf,
  snapshotsEqual,
  uniqueWorkflowName,
  undoHistory,
  type BoardEdge,
  type BoardLogEntry,
  type BoardNode,
  type BoardsState,
  type History,
  type PendingWake,
  type RunRecord,
  type RunRequestRecord,
  type Workflow,
  type WorkflowSettings,
} from "./boardModel";

export type {
  BoardEdge,
  BoardLogEntry,
  BoardNode,
  BoardsState,
  PendingWake,
  RunRecord,
  RunRequest,
  RunRequestRecord,
  RunStatus,
  Workflow,
  WorkflowSettings,
} from "./boardModel";

const BOARD_STORAGE_KEY = "t3.board.v2";
const LEGACY_BOARD_STORAGE_KEY = "t3.board.v1";
const PROCESSED_STORAGE_KEY = "t3.board.processed.v1";
const MAX_PROCESSED = 2000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable or full; the board keeps working in memory.
  }
}

let state: BoardsState = migrateBoards(
  readJson<unknown>(BOARD_STORAGE_KEY, null),
  readJson<unknown>(LEGACY_BOARD_STORAGE_KEY, null),
  randomUUID,
);
let processed: ReadonlySet<string> = new Set(readJson<string[]>(PROCESSED_STORAGE_KEY, []));
const listeners = new Set<() => void>();

// In-memory undo history per workflow; created lazily and reset whenever a workflow is opened.
const histories = new Map<string, History>();

export interface BoardHistoryView {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
}
const NO_HISTORY: BoardHistoryView = { canUndo: false, canRedo: false, dirty: false };
let historyView: BoardHistoryView = NO_HISTORY;

function historyOf(workflow: Workflow): History {
  let history = histories.get(workflow.id);
  if (!history) {
    history = createHistory(snapshotOf(workflow));
    histories.set(workflow.id, history);
  }
  return history;
}

function computeHistoryView(): BoardHistoryView {
  const workflow = currentWorkflowOf(state);
  const history = historyOf(workflow);
  const next: BoardHistoryView = {
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    dirty: !snapshotsEqual(snapshotOf(workflow), history.origin),
  };
  return next.canUndo === historyView.canUndo &&
    next.canRedo === historyView.canRedo &&
    next.dirty === historyView.dirty
    ? historyView
    : next;
}

function currentWorkflowOf(boards: BoardsState): Workflow {
  return (
    boards.workflows.find((workflow) => workflow.id === boards.currentId) ?? boards.workflows[0]!
  );
}

function emit() {
  historyView = computeHistoryView();
  for (const listener of listeners) listener();
}

function setState(next: BoardsState) {
  state = next;
  writeJson(BOARD_STORAGE_KEY, state);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

historyView = computeHistoryView();

// ---------------------------------------------------------------------------------------------
// Reads

export function getBoards(): BoardsState {
  return state;
}

export function getWorkflow(id: string): Workflow | undefined {
  return state.workflows.find((workflow) => workflow.id === id);
}

export function getCurrentWorkflow(): Workflow {
  return currentWorkflowOf(state);
}

export function findWorkflowOfNode(nodeId: string): Workflow | undefined {
  return state.workflows.find((workflow) => workflow.nodes.some((node) => node.id === nodeId));
}

export function useBoards(): BoardsState {
  return useSyncExternalStore(subscribe, getBoards, getBoards);
}

/**
 * The workflow currently shown on the Board: `id`, `name`, `nodes`, `edges`, `pending`, `log`,
 * `runs` and `settings`. Stable between store changes that do not touch it.
 */
export function useCurrentWorkflow(): Workflow {
  return useSyncExternalStore(subscribe, getCurrentWorkflow, getCurrentWorkflow);
}

export function useWorkflows(): ReadonlyArray<Workflow> {
  return useBoards().workflows;
}

export function useBoardHistory(): BoardHistoryView {
  return useSyncExternalStore(
    subscribe,
    () => historyView,
    () => historyView,
  );
}

/** Active (running) run of a workflow, if any. */
export function activeRunOf(workflow: Workflow): RunRecord | undefined {
  return workflow.runs.find((run) => run.status === "running");
}

export function isProcessed(messageId: string): boolean {
  return processed.has(messageId);
}

export function markProcessed(messageIds: ReadonlyArray<string>) {
  const next = new Set(processed);
  for (const id of messageIds) next.add(id);
  processed = next;
  writeJson(PROCESSED_STORAGE_KEY, [...next].slice(-MAX_PROCESSED));
}

// ---------------------------------------------------------------------------------------------
// Mutations

function mapWorkflow(id: string, update: (workflow: Workflow) => Workflow) {
  let changed = false;
  const workflows = state.workflows.map((workflow) => {
    if (workflow.id !== id) return workflow;
    const next = update(workflow);
    if (next !== workflow) changed = true;
    return next;
  });
  if (changed) setState({ ...state, workflows });
}

/** Applies an edit to nodes/edges and records an undo step first. */
function editWorkflow(id: string, update: (workflow: Workflow) => Workflow) {
  const workflow = getWorkflow(id);
  if (!workflow) return;
  const next = update(workflow);
  if (next === workflow) return;
  histories.set(id, recordHistory(historyOf(workflow), snapshotOf(workflow)));
  mapWorkflow(id, () => next);
}

/** Call once when a drag starts, so the whole move is one undo step. */
export function recordHistoryStep() {
  const workflow = getCurrentWorkflow();
  histories.set(workflow.id, recordHistory(historyOf(workflow), snapshotOf(workflow)));
  emit();
}

export function undo() {
  const workflow = getCurrentWorkflow();
  const result = undoHistory(historyOf(workflow), snapshotOf(workflow));
  if (!result) return;
  histories.set(workflow.id, result.history);
  mapWorkflow(workflow.id, (current) => applySnapshot(current, result.snapshot));
  emit();
}

export function redo() {
  const workflow = getCurrentWorkflow();
  const result = redoHistory(historyOf(workflow), snapshotOf(workflow));
  if (!result) return;
  histories.set(workflow.id, result.history);
  mapWorkflow(workflow.id, (current) => applySnapshot(current, result.snapshot));
  emit();
}

/** Reverts nodes and edges to how they were when the workflow was opened. */
export function discardChanges() {
  const workflow = getCurrentWorkflow();
  const result = discardHistory(historyOf(workflow));
  histories.set(workflow.id, result.history);
  mapWorkflow(workflow.id, (current) => applySnapshot(current, result.snapshot));
  emit();
}

export function setCurrentWorkflow(id: string) {
  if (id === state.currentId || !getWorkflow(id)) return;
  const target = getWorkflow(id)!;
  histories.set(id, createHistory(snapshotOf(target)));
  setState({ ...state, currentId: id });
}

export function createNewWorkflow(name?: string): string {
  const id = randomUUID();
  const finalName = uniqueWorkflowName(
    state.workflows.map((workflow) => workflow.name),
    name?.trim() || "Workflow",
  );
  const workflow = createWorkflow(id, finalName);
  histories.set(id, createHistory(snapshotOf(workflow)));
  setState({ workflows: [...state.workflows, workflow], currentId: id });
  return id;
}

export function renameWorkflow(id: string, name: string) {
  const trimmed = name.trim();
  if (trimmed === "") return;
  mapWorkflow(id, (workflow) =>
    workflow.name === trimmed ? workflow : { ...workflow, name: trimmed },
  );
}

/**
 * Copies a workflow's name and settings. Agents are not copied: a node belongs to exactly one
 * workflow, because a thread must only be driven by one set of edges.
 */
export function duplicateWorkflow(id: string): string | null {
  const source = getWorkflow(id);
  if (!source) return null;
  const copy = createWorkflow(
    randomUUID(),
    uniqueWorkflowName(
      state.workflows.map((workflow) => workflow.name),
      `${source.name} copy`,
    ),
  );
  const workflow = { ...copy, settings: source.settings };
  histories.set(workflow.id, createHistory(snapshotOf(workflow)));
  setState({ workflows: [...state.workflows, workflow], currentId: workflow.id });
  return workflow.id;
}

/** Removing the last workflow leaves a fresh empty one. */
export function removeWorkflow(id: string) {
  if (!getWorkflow(id)) return;
  histories.delete(id);
  const remaining = state.workflows.filter((workflow) => workflow.id !== id);
  if (remaining.length === 0) {
    const fresh = createWorkflow(randomUUID(), "Workflow");
    histories.set(fresh.id, createHistory(snapshotOf(fresh)));
    setState({ workflows: [fresh], currentId: fresh.id });
    return;
  }
  const currentId = state.currentId === id ? remaining[0]!.id : state.currentId;
  if (currentId !== state.currentId) {
    histories.set(currentId, createHistory(snapshotOf(remaining[0]!)));
  }
  setState({ workflows: remaining, currentId });
}

export function updateWorkflowSettings(patch: Partial<WorkflowSettings>, workflowId?: string) {
  mapWorkflow(workflowId ?? state.currentId, (workflow) => ({
    ...workflow,
    settings: { ...workflow.settings, ...patch },
  }));
}

const GRID_COLUMNS = 4;
const GRID_STEP_X = 300;
const GRID_STEP_Y = 230;

function nextFreeSlot(nodes: ReadonlyArray<BoardNode>): { x: number; y: number } {
  for (let index = 0; ; index++) {
    const x = 40 + (index % GRID_COLUMNS) * GRID_STEP_X;
    const y = 40 + Math.floor(index / GRID_COLUMNS) * GRID_STEP_Y;
    if (
      !nodes.some(
        (node) => Math.abs(node.x - x) < GRID_STEP_X && Math.abs(node.y - y) < GRID_STEP_Y,
      )
    ) {
      return { x, y };
    }
  }
}

/** True when some workflow already drives this thread. */
export function isThreadOnBoard(environmentId: string, threadId: string): boolean {
  return state.workflows.some((workflow) =>
    workflow.nodes.some(
      (node) => node.environmentId === environmentId && node.threadId === threadId,
    ),
  );
}

export function addNode(
  input: Pick<BoardNode, "name" | "environmentId" | "threadId"> &
    Partial<Pick<BoardNode, "baselined" | "awaitingFirstReply">>,
  workflowId: string = state.currentId,
): string {
  const id = randomUUID();
  editWorkflow(workflowId, (workflow) => {
    const { x, y } = nextFreeSlot(workflow.nodes);
    const node: BoardNode = { baselined: false, ...input, id, x, y };
    return { ...workflow, nodes: [...workflow.nodes, node] };
  });
  return id;
}

function patchNode(id: string, patch: Partial<BoardNode>, record: boolean) {
  const owner = findWorkflowOfNode(id);
  if (!owner) return;
  const apply = (workflow: Workflow): Workflow => ({
    ...workflow,
    nodes: workflow.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
  });
  if (record) editWorkflow(owner.id, apply);
  else mapWorkflow(owner.id, apply);
}

/** Position and engine bookkeeping changes; not an undo step (see `recordHistoryStep`). */
export function updateNode(
  id: string,
  patch: Partial<Pick<BoardNode, "x" | "y" | "baselined" | "awaitingFirstReply">>,
) {
  patchNode(id, patch, false);
}

export function renameNode(id: string, name: string) {
  const trimmed = name.trim();
  if (trimmed === "") return;
  patchNode(id, { name: trimmed }, true);
}

export function removeNode(id: string) {
  const owner = findWorkflowOfNode(id);
  if (!owner) return;
  editWorkflow(owner.id, (workflow) => ({
    ...workflow,
    nodes: workflow.nodes.filter((node) => node.id !== id),
    edges: workflow.edges.filter((edge) => edge.a !== id && edge.b !== id),
    pending: workflow.pending.filter((wake) => wake.from !== id && wake.to !== id),
  }));
}

function sameEdgePair(edge: BoardEdge, a: string, b: string) {
  return (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a);
}

export function areConnected(a: string, b: string): boolean {
  return findWorkflowOfNode(a)?.edges.some((edge) => sameEdgePair(edge, a, b)) ?? false;
}

/** True when a saved edge lets `from` send work requests to `to`. */
export function canRequest(from: string, to: string): boolean {
  return findWorkflowOfNode(from)?.edges.some((edge) => edge.a === from && edge.b === to) ?? false;
}

export function addEdge(a: string, b: string): boolean {
  const owner = findWorkflowOfNode(a);
  if (a === b || !owner || !owner.nodes.some((node) => node.id === b) || areConnected(a, b)) {
    return false;
  }
  editWorkflow(owner.id, (workflow) => ({ ...workflow, edges: [...workflow.edges, { a, b }] }));
  return true;
}

export function removeEdge(a: string, b: string) {
  const owner = findWorkflowOfNode(a);
  if (!owner || !areConnected(a, b)) return;
  editWorkflow(owner.id, (workflow) => ({
    ...workflow,
    edges: workflow.edges.filter((edge) => !sameEdgePair(edge, a, b)),
  }));
}

export function toggleEdge(a: string, b: string) {
  if (areConnected(a, b)) removeEdge(a, b);
  else addEdge(a, b);
}

// ---- Runs and engine bookkeeping (not undoable) ----

/** Queues a workflow run; the engine sends `task` to the entry node and clears the request. */
export function requestRun(nodeId: string, task: string) {
  const owner = findWorkflowOfNode(nodeId);
  if (!owner) return;
  mapWorkflow(owner.id, (workflow) => ({
    ...workflow,
    runQueue: [...workflow.runQueue, { id: randomUUID(), nodeId, task }],
  }));
}

export function clearRunRequest(workflowId: string, id: string) {
  mapWorkflow(workflowId, (workflow) => ({
    ...workflow,
    runQueue: workflow.runQueue.filter((run) => run.id !== id),
  }));
}

export function addPending(workflowId: string, wake: PendingWake) {
  mapWorkflow(workflowId, (workflow) => ({ ...workflow, pending: [...workflow.pending, wake] }));
}

export function removePending(workflowId: string, id: string) {
  mapWorkflow(workflowId, (workflow) => ({
    ...workflow,
    pending: workflow.pending.filter((wake) => wake.id !== id),
  }));
}

export function appendLog(kind: BoardLogEntry["kind"], text: string, workflowId?: string) {
  const entry: BoardLogEntry = { id: randomUUID(), at: new Date().toISOString(), kind, text };
  mapWorkflow(workflowId ?? state.currentId, (workflow) => ({
    ...workflow,
    log: [entry, ...workflow.log].slice(0, MAX_LOG),
  }));
}

export function startRun(
  workflowId: string,
  input: {
    readonly id: string;
    readonly nodeId: string;
    readonly nodeName: string;
    readonly task: string;
  },
) {
  const run: RunRecord = {
    ...input,
    status: "running",
    startedAt: new Date().toISOString(),
    requests: [],
  };
  mapWorkflow(workflowId, (workflow) => ({
    ...workflow,
    runs: [run, ...workflow.runs].slice(0, MAX_RUNS),
  }));
}

export function updateRun(workflowId: string, runId: string, patch: Partial<RunRecord>) {
  mapWorkflow(workflowId, (workflow) => ({
    ...workflow,
    runs: workflow.runs.map((run) => (run.id === runId ? { ...run, ...patch } : run)),
  }));
}

export function endRun(
  workflowId: string,
  runId: string,
  status: Exclude<RunRecord["status"], "running">,
  patch: Partial<Pick<RunRecord, "summary" | "data">> = {},
) {
  updateRun(workflowId, runId, { ...patch, status, endedAt: new Date().toISOString() });
}

export function addRunRequest(workflowId: string, runId: string, request: RunRequestRecord) {
  mapWorkflow(workflowId, (workflow) => ({
    ...workflow,
    runs: workflow.runs.map((run) =>
      run.id === runId ? { ...run, requests: [...run.requests, request] } : run,
    ),
  }));
}

export function updateRunRequest(
  workflowId: string,
  requestId: string,
  patch: Partial<RunRequestRecord>,
) {
  mapWorkflow(workflowId, (workflow) => ({
    ...workflow,
    runs: workflow.runs.map((run) =>
      run.requests.some((request) => request.id === requestId)
        ? {
            ...run,
            requests: run.requests.map((request) =>
              request.id === requestId ? { ...request, ...patch } : request,
            ),
          }
        : run,
    ),
  }));
}

/** Stop: pending requests and queued runs are dropped; the active run is marked stopped. */
export function stopWorkflowRun(workflowId: string) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return;
  const at = new Date().toISOString();
  mapWorkflow(workflowId, (current) => ({
    ...current,
    pending: [],
    runQueue: [],
    runs: current.runs.map((run) =>
      run.status === "running"
        ? {
            ...run,
            status: "stopped" as const,
            endedAt: at,
            requests: run.requests.map((request) =>
              request.status === "pending" ? { ...request, status: "dropped" as const } : request,
            ),
          }
        : run,
    ),
  }));
}
