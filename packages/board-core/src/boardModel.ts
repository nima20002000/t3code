import type { EnvironmentId, ProjectId, RuntimeMode, ThreadId } from "@t3tools/contracts";

/** Pure board data model: types, defaults, storage migration and undo history. No React, no storage. */

export interface BoardNode {
  readonly id: string;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly threadId: ThreadId;
  readonly x: number;
  readonly y: number;
  /** True once the messages that existed when the node was added were marked processed. */
  readonly baselined: boolean;
  /** Set for agents the board started: their first reply answers the setup prompt and is skipped. */
  readonly awaitingFirstReply?: boolean;
  /** Free-form note about what this agent does; edited in the node settings. */
  readonly role?: string;
}

/** Directed work connection: `a` (source) may send work requests to `b` (target), which returns to `a`. */
export interface BoardEdge {
  readonly a: string;
  readonly b: string;
}

/** A user-started workflow run waiting for the engine to send its task to the entry node. */
export interface RunRequest {
  readonly id: string;
  readonly nodeId: string;
  readonly task: string;
}

export interface PendingWake {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface BoardLogEntry {
  readonly id: string;
  readonly at: string;
  readonly kind: "wake" | "result" | "info" | "run" | "error";
  readonly text: string;
}

export type RunStatus = "running" | "finished" | "stopped" | "failed";

/** One work request made during a run, with its eventual return. */
export interface RunRequestRecord {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  /** Node names at the time of the request. */
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly task: string;
  readonly input?: unknown;
  readonly status: "pending" | "returned" | "denied" | "dropped" | "failed" | "stopped";
  readonly returnedAt?: string;
  readonly returnSummary?: string;
  readonly returnData?: unknown;
  readonly failureReason?: string;
}

export interface RunRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly task: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly summary?: string;
  readonly data?: unknown;
  readonly requests: ReadonlyArray<RunRequestRecord>;
}

export interface WorkflowSettings {
  /** Provider instance id used by Add agent. */
  readonly defaultInstanceId: string;
  readonly defaultModel: string;
  readonly runtimeMode: RuntimeMode;
  /** Max requests per edge per run; null means unlimited. */
  readonly maxHandoffsPerEdge: number | null;
  /** Omitted means allSettled. */
  readonly waitPolicy?: "allSettled" | "failFast";
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly nodes: ReadonlyArray<BoardNode>;
  readonly edges: ReadonlyArray<BoardEdge>;
  readonly pending: ReadonlyArray<PendingWake>;
  readonly log: ReadonlyArray<BoardLogEntry>;
  readonly runQueue: ReadonlyArray<RunRequest>;
  readonly runs: ReadonlyArray<RunRecord>;
  readonly settings: WorkflowSettings;
}

export interface BoardsState {
  readonly workflows: ReadonlyArray<Workflow>;
  readonly currentId: string;
}

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  defaultInstanceId: "codex",
  defaultModel: "gpt-6-luna",
  runtimeMode: "full-access",
  maxHandoffsPerEdge: null,
};

export const MAX_LOG = 200;
export const MAX_RUNS = 50;

export function createWorkflow(id: string, name: string): Workflow {
  return {
    id,
    name,
    nodes: [],
    edges: [],
    pending: [],
    log: [],
    runQueue: [],
    runs: [],
    settings: DEFAULT_WORKFLOW_SETTINGS,
  };
}

function asArray<T>(value: unknown): ReadonlyArray<T> {
  return Array.isArray(value) ? (value as ReadonlyArray<T>) : [];
}

function normalizeWorkflow(raw: Partial<Workflow> & { id: string; name: string }): Workflow {
  return {
    id: raw.id,
    name: raw.name,
    nodes: asArray(raw.nodes),
    edges: asArray(raw.edges),
    pending: asArray(raw.pending),
    log: asArray(raw.log),
    runQueue: asArray(raw.runQueue),
    runs: asArray(raw.runs),
    settings: { ...DEFAULT_WORKFLOW_SETTINGS, ...raw.settings },
  };
}

/**
 * Reads persisted data: the multi-workflow shape (v2), or the original single board (v1, whose
 * nodes/edges/pending/log/runQueue become a workflow named "Workflow"). Anything else gives one
 * empty workflow.
 */
export function migrateBoards(v2: unknown, v1: unknown, newId: () => string): BoardsState {
  if (v2 !== null && typeof v2 === "object") {
    const candidate = v2 as Partial<BoardsState>;
    if (Array.isArray(candidate.workflows) && candidate.workflows.length > 0) {
      const workflows = candidate.workflows
        .filter((workflow): workflow is Workflow => typeof workflow?.id === "string")
        .map((workflow) =>
          normalizeWorkflow({ ...workflow, name: String(workflow.name ?? "Workflow") }),
        );
      if (workflows.length > 0) {
        const currentId = workflows.some((workflow) => workflow.id === candidate.currentId)
          ? (candidate.currentId as string)
          : workflows[0]!.id;
        return { workflows, currentId };
      }
    }
  }
  const legacy = v1 !== null && typeof v1 === "object" ? (v1 as Partial<Workflow>) : {};
  const id = newId();
  return {
    workflows: [
      normalizeWorkflow({
        nodes: legacy.nodes ?? [],
        edges: legacy.edges ?? [],
        pending: legacy.pending ?? [],
        log: legacy.log ?? [],
        runQueue: legacy.runQueue ?? [],
        id,
        name: "Workflow",
      }),
    ],
    currentId: id,
  };
}

/** Picks a name not used by other workflows: "Base", "Base 2", ... */
export function uniqueWorkflowName(names: ReadonlyArray<string>, base: string): string {
  if (!names.includes(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base} ${index}`;
    if (!names.includes(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------------------------
// Undo history

export const MAX_HISTORY = 100;

/** Undoable part of a workflow. */
export interface EditSnapshot {
  readonly nodes: ReadonlyArray<BoardNode>;
  readonly edges: ReadonlyArray<BoardEdge>;
}

export interface History {
  /** State when the workflow was opened; Discard returns here. */
  readonly origin: EditSnapshot;
  readonly past: ReadonlyArray<EditSnapshot>;
  readonly future: ReadonlyArray<EditSnapshot>;
}

export function snapshotOf(workflow: Pick<Workflow, "nodes" | "edges">): EditSnapshot {
  return { nodes: workflow.nodes, edges: workflow.edges };
}

export function createHistory(origin: EditSnapshot): History {
  return { origin, past: [], future: [] };
}

/** Records `current` as an undo step (call before applying an edit). Clears redo. */
export function recordHistory(history: History, current: EditSnapshot): History {
  const last = history.past.at(-1);
  if (last !== undefined && last.nodes === current.nodes && last.edges === current.edges) {
    return { ...history, future: [] };
  }
  return { ...history, past: [...history.past, current].slice(-MAX_HISTORY), future: [] };
}

export function undoHistory(
  history: History,
  current: EditSnapshot,
): { readonly history: History; readonly snapshot: EditSnapshot } | null {
  const snapshot = history.past.at(-1);
  if (snapshot === undefined) return null;
  return {
    snapshot,
    history: { ...history, past: history.past.slice(0, -1), future: [...history.future, current] },
  };
}

export function redoHistory(
  history: History,
  current: EditSnapshot,
): { readonly history: History; readonly snapshot: EditSnapshot } | null {
  const snapshot = history.future.at(-1);
  if (snapshot === undefined) return null;
  return {
    snapshot,
    history: { ...history, future: history.future.slice(0, -1), past: [...history.past, current] },
  };
}

export function discardHistory(history: History): {
  readonly history: History;
  readonly snapshot: EditSnapshot;
} {
  return { snapshot: history.origin, history: createHistory(history.origin) };
}

/**
 * Dropped nodes take their pending wakes with them. Engine bookkeeping flags (`baselined`,
 * `awaitingFirstReply`) of surviving nodes are kept, so undo cannot make the engine re-read a thread.
 */
export function applySnapshot(workflow: Workflow, snapshot: EditSnapshot): Workflow {
  const current = new Map(workflow.nodes.map((node) => [node.id, node]));
  const nodes = snapshot.nodes.map((node) => {
    const live = current.get(node.id);
    if (live === undefined) return node;
    const { awaitingFirstReply: _stale, ...rest } = node;
    return live.awaitingFirstReply === undefined
      ? { ...rest, baselined: live.baselined }
      : { ...rest, baselined: live.baselined, awaitingFirstReply: live.awaitingFirstReply };
  });
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...workflow,
    nodes,
    edges: snapshot.edges,
    pending: workflow.pending.filter((wake) => ids.has(wake.from) && ids.has(wake.to)),
  };
}

export function snapshotsEqual(a: EditSnapshot, b: EditSnapshot): boolean {
  return (
    a === b ||
    (a.nodes === b.nodes && a.edges === b.edges) ||
    JSON.stringify(a) === JSON.stringify(b)
  );
}
