import { ProjectId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";

/** Pure board data model: types, defaults, storage migration and undo history. No React, no storage. */

/** Built-in agent profiles: what a node is told it is. There is no per-node thread; runs launch one. */
export type AgentProfile = "worker" | "orchestrator";

export interface BoardNode {
  readonly id: string;
  readonly name: string;
  readonly profile: AgentProfile;
  readonly environmentId: EnvironmentId;
  readonly modelSelection: ModelSelection;
  /** Replaces the profile's role text in the node's instructions. */
  readonly prompt?: string;
  /** The node's own chat thread outside runs, launched on first open. */
  readonly chat?: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    /** Set on a chat started anew; it then outranks the threads of runs started before it. */
    readonly startedAt?: string;
  };
  /** The t3 scheduled task on the chat's machine that sends a prompt into the chat. */
  readonly schedule?: {
    readonly environmentId: EnvironmentId;
    readonly taskId: ScheduledTaskId;
    /**
     * The thread the board last bound the task to; another one means the machine moved it.
     * Unset on early markers, which were bound to the node's chat.
     */
    readonly threadId?: ThreadId;
    /** Set by "/new" until the machine binds the task to the new chat with these settings. */
    readonly rebind?: {
      readonly modelSelection?: ModelSelection;
      readonly runtimeMode?: RuntimeMode;
      readonly interactionMode?: ProviderInteractionMode;
    };
  };
  /** Overrides the workflow's runtime mode for this agent's threads. */
  readonly runtimeMode?: RuntimeMode;
  /** Diameter on the canvas; unset means the profile's default size. */
  readonly size?: number;
  readonly x: number;
  readonly y: number;
}

/** A workspace's folder on one machine. The board creates and removes the t3 project when `managed`. */
export interface WorkspaceFolder {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
  readonly managed: boolean;
}

/** Board-owned grouping of workflows with one folder per machine; its agents run in those folders. */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly folders: ReadonlyArray<WorkspaceFolder>;
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

export type RunStatus = "running" | "stopping" | "finished" | "stopped" | "failed";

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

/** The thread a run launched for a node. `seeded` is set once the node's instructions were sent. */
export interface RunThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly seeded: boolean;
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
  /** nodeId -> the thread this run launched for it, or carried over from the schedule's last run. */
  readonly threads: Readonly<Record<string, RunThread>>;
  /** The workflow as it was when the run started; later edits never change a run. */
  readonly definition: WorkflowDefinition;
  /** Its chats carry into the schedule's next run, so they are compacted once it ends. */
  readonly compactAfter?: boolean;
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

export interface WorkflowDefinition {
  readonly nodes: ReadonlyArray<BoardNode>;
  readonly edges: ReadonlyArray<BoardEdge>;
  readonly settings: WorkflowSettings;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly nodes: ReadonlyArray<BoardNode>;
  readonly edges: ReadonlyArray<BoardEdge>;
  readonly pending: ReadonlyArray<PendingWake>;
  readonly log: ReadonlyArray<BoardLogEntry>;
  readonly runQueue: ReadonlyArray<RunRequest>;
  readonly runs: ReadonlyArray<RunRecord>;
  readonly settings: WorkflowSettings;
}

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  defaultInstanceId: "codex",
  defaultModel: "gpt-6-luna",
  runtimeMode: "full-access",
  maxHandoffsPerEdge: null,
};

export const MAX_LOG = 200;
export const MAX_RUNS = 50;

export function createWorkflow(id: string, name: string, workspaceId: string): Workflow {
  return {
    id,
    name,
    workspaceId,
    nodes: [],
    edges: [],
    pending: [],
    log: [],
    runQueue: [],
    runs: [],
    settings: DEFAULT_WORKFLOW_SETTINGS,
  };
}

/** Lowercase letters, digits and dashes: the workspace's folder name. */
export function workspaceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
}

/** The name is the default folder name on every machine, so two workspaces cannot share its slug. */
export function workspaceNameTaken(
  workspaces: ReadonlyArray<Pick<Workspace, "id" | "name">>,
  name: string,
  ownId?: string,
): boolean {
  const wanted = workspaceSlug(name);
  return workspaces.some((entry) => entry.id !== ownId && workspaceSlug(entry.name) === wanted);
}

export const WORKSPACES_ROOT = "~/t3-workspaces";

/**
 * The folder a workspace gets on a machine it has none on yet; `~` expands on that machine.
 * t3 never reuses a project id, so each folder needs a fresh `uniqueId`.
 */
export function defaultFolder(
  workspace: Workspace,
  environmentId: EnvironmentId,
  uniqueId: string,
): WorkspaceFolder {
  return {
    environmentId,
    projectId: ProjectId.make(`board:${workspace.id}:${uniqueId}`),
    path: `${WORKSPACES_ROOT}/${workspaceSlug(workspace.name)}`,
    managed: true,
  };
}

/** The workspace with a folder on that machine, adding the default one when it has none. */
export function withFolder(
  workspace: Workspace,
  environmentId: EnvironmentId,
  uniqueId: string,
): Workspace {
  return workspace.folders.some((folder) => folder.environmentId === environmentId)
    ? workspace
    : {
        ...workspace,
        folders: [...workspace.folders, defaultFolder(workspace, environmentId, uniqueId)],
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

/** Dropped nodes take their pending wakes with them. */
export function applySnapshot(workflow: Workflow, snapshot: EditSnapshot): Workflow {
  const ids = new Set(snapshot.nodes.map((node) => node.id));
  return {
    ...workflow,
    nodes: snapshot.nodes,
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
