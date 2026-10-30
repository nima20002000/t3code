import { useAtomValue } from "@effect/atom-react";
import {
  type BoardCreateNodeInput,
  type BoardNewNodeChatInput,
  type BoardSaveNodeScheduleInput,
  type BoardUpdateNodeInput,
  type BoardPeer,
  type BoardSchedule,
  type BoardSnapshot,
  type BoardWorkspaceFiles,
} from "@t3tools/board-core/http";
import {
  createHistory,
  discardHistory,
  recordHistory,
  redoHistory,
  snapshotOf,
  snapshotsEqual,
  undoHistory,
  uniqueWorkflowName,
  type BoardNode as CoreNode,
  type History,
  type KanbanPlacement,
  type WorkflowSettings,
} from "@t3tools/board-core/boardModel";
import type { EnvironmentId } from "@t3tools/contracts";
import type { KanbanCard } from "@t3tools/board-core/kanban";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { agentNodeSize } from "./foreman/signalEdge";
import { runBoardApi, runBoardMutation, streamBoardEvents } from "./boardApi";
import { applyBoardEvent, workflowView, type Workflow } from "./boardState";

export type { BoardNode, Workflow } from "./boardState";
export type {
  BoardEdge,
  BoardLogEntry,
  PendingWake,
  RunRecord,
  RunRequest,
  RunRequestRecord,
  KanbanPlacement,
  RunStatus,
  WorkflowSettings,
} from "@t3tools/board-core/boardModel";
import { appAtomRegistry, randomUUID, toastManager } from "./upstream";

interface BoardState {
  readonly snapshot: BoardSnapshot | null;
  readonly currentId: string;
  readonly status: "loading" | "connected" | "offline";
  readonly error: string | null;
  readonly historyVersion: number;
}

const CURRENT_KEY = "t3.board.currentWorkflow";
function storedWorkflowId() {
  try {
    return localStorage.getItem(CURRENT_KEY) ?? "";
  } catch {
    return "";
  }
}

// Kept across hot reloads so a reloaded module keeps the atom the mounted page reads.
const hotData: { boardStateAtom?: Atom.Writable<BoardState> } = import.meta.hot?.data ?? {};
const boardStateAtom: Atom.Writable<BoardState> =
  hotData.boardStateAtom ??
  Atom.make<BoardState>({
    snapshot: null,
    currentId: storedWorkflowId(),
    status: "loading",
    error: null,
    historyVersion: 0,
  }).pipe(Atom.withLabel("board-hub-state"));
hotData.boardStateAtom = boardStateAtom;
const histories = new Map<string, History>();
const getState = () => appAtomRegistry.get(boardStateAtom);
const setState = (patch: Partial<BoardState>) => {
  appAtomRegistry.set(boardStateAtom, { ...getState(), ...patch });
  if (patch.currentId) {
    try {
      localStorage.setItem(CURRENT_KEY, patch.currentId);
    } catch {
      // The selection just isn't remembered.
    }
  }
};
const getSnapshot = () => getState().snapshot;

export function setSnapshot(snapshot: BoardSnapshot) {
  const previous = getState();
  const currentId =
    [previous.currentId, storedWorkflowId()].find((id) =>
      snapshot.workflows.some((w) => w.id === id),
    ) ??
    snapshot.workflows[0]?.id ??
    "";
  setState({ snapshot, currentId, status: "connected", error: null });
}

export function useBoardConnection() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the hub stream connected while the board is open.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const snapshot = await runBoardApi(
          (client) => client.getSnapshot({ headers: {} }),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setSnapshot(snapshot);
        await streamBoardEvents(
          snapshot.sequence,
          (event) => {
            const current = getSnapshot();
            if (current) setSnapshot(applyBoardEvent(current, event));
          },
          controller.signal,
        );
        if (!controller.signal.aborted) throw new Error("Board event stream closed.");
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: "offline",
          error: error instanceof Error ? error.message : String(error),
        });
        timer = setTimeout(() => void connect(), 5000);
      }
    };
    void connect();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);
}

export function useBoardState() {
  return useAtomValue(boardStateAtom);
}
export function useBoards() {
  const { snapshot, currentId } = useBoardState();
  return { workflows: (snapshot?.workflows ?? []).map(workflowView), currentId };
}
function getWorkflow(id: string): Workflow | undefined {
  const workflow = getSnapshot()?.workflows.find((entry) => entry.id === id);
  return workflow && workflowView(workflow);
}
export function getCurrentWorkflow(): Workflow {
  const { snapshot, currentId } = getState();
  const current = snapshot?.workflows.find((w) => w.id === currentId) ?? snapshot?.workflows[0];
  return (current && workflowView(current))!;
}
export function useCurrentWorkflow(): Workflow {
  const { snapshot, currentId } = useBoardState();
  const current = snapshot?.workflows.find((w) => w.id === currentId) ?? snapshot?.workflows[0];
  return (current && workflowView(current))!;
}
export const activeRunOf = (workflow: Workflow) =>
  workflow.runs.find((run) => run.status === "running" || run.status === "stopping");
export function useBoardWorkspaces() {
  return useBoardState().snapshot?.workspaces ?? [];
}
const NO_CARDS: ReadonlyArray<KanbanCard> = [];
export function useKanbanCards(workflowId: string): ReadonlyArray<KanbanCard> {
  return (
    useBoardState().snapshot?.kanban.find((entry) => entry.workflowId === workflowId)?.cards ??
    NO_CARDS
  );
}
export function useBoardPeers(): ReadonlyArray<BoardPeer> {
  return useBoardState().snapshot?.peers ?? [];
}
export function useBoardSchedules(): ReadonlyArray<BoardSchedule> {
  return useBoardState().snapshot?.schedules ?? [];
}

const NO_FILES: Omit<BoardWorkspaceFiles, "workspaceId"> = { files: [], machines: [] };
/** The workspace's shared files on the hub, and each machine's copy state. */
export function useWorkspaceFiles(workspaceId: string): Omit<BoardWorkspaceFiles, "workspaceId"> {
  return (
    useBoardState().snapshot?.files?.find((entry) => entry.workspaceId === workspaceId) ?? NO_FILES
  );
}

function reportError(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}
function perform(title: string, action: () => Promise<unknown>) {
  void action().catch((error: unknown) => reportError(title, error));
}
function changedHistory() {
  setState({ historyVersion: getState().historyVersion + 1 });
}
function historyOf(workflow: Workflow) {
  const history = histories.get(workflow.id) ?? createHistory(snapshotOf(workflow));
  histories.set(workflow.id, history);
  return history;
}
function edit(action: (workflow: Workflow) => Promise<unknown>) {
  const workflow = getCurrentWorkflow();
  const history = recordHistory(historyOf(workflow), snapshotOf(workflow));
  perform("Could not update the board", async () => {
    await action(workflow);
    histories.set(workflow.id, history);
    changedHistory();
  });
}
export function useBoardHistory() {
  useBoardState();
  const workflow = getCurrentWorkflow();
  const history = historyOf(workflow);
  return {
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    // Restore returns to the board as it was when opened; an empty board has nothing to return to.
    restorable:
      history.origin.nodes.length > 0 && !snapshotsEqual(snapshotOf(workflow), history.origin),
  };
}

function nodeInput(node: CoreNode): BoardCreateNodeInput {
  return {
    id: node.id,
    name: node.name,
    profile: node.profile,
    environmentId: node.environmentId,
    modelSelection: node.modelSelection,
    ...(node.prompt === undefined ? {} : { prompt: node.prompt }),
    ...(node.runtimeMode === undefined ? {} : { runtimeMode: node.runtimeMode }),
    ...(node.size === undefined ? {} : { size: node.size }),
    x: node.x,
    y: node.y,
  };
}
async function restore(workflow: Workflow, target: ReturnType<typeof snapshotOf>) {
  const targetNodes = new Map(target.nodes.map((node) => [node.id, node]));
  const currentNodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const edgeKey = (edge: { a: string; b: string }) => `${edge.a}\0${edge.b}`;
  const targetEdges = new Set(target.edges.map(edgeKey));
  const currentEdges = new Set(workflow.edges.map(edgeKey));
  for (const edge of workflow.edges)
    if (!targetEdges.has(edgeKey(edge))) {
      await runBoardMutation((client) =>
        client.deleteEdge({
          headers: {},
          params: { workflowId: workflow.id, fromId: edge.a, toId: edge.b },
        }),
      );
    }
  for (const node of workflow.nodes)
    if (!targetNodes.has(node.id)) {
      await runBoardMutation((client) =>
        client.deleteNode({ headers: {}, params: { workflowId: workflow.id, nodeId: node.id } }),
      );
    }
  for (const node of target.nodes) {
    if (!currentNodes.has(node.id)) {
      await runBoardMutation((client) =>
        client.createNode({
          headers: {},
          params: { workflowId: workflow.id },
          payload: nodeInput(node),
        }),
      );
    } else {
      const { id: _id, ...patch } = nodeInput(node);
      await runBoardMutation((client) =>
        client.updateNode({
          headers: {},
          params: { workflowId: workflow.id, nodeId: node.id },
          payload: patch,
        }),
      );
    }
  }
  for (const edge of target.edges)
    if (!currentEdges.has(edgeKey(edge))) {
      await runBoardMutation((client) =>
        client.createEdge({ headers: {}, params: { workflowId: workflow.id }, payload: edge }),
      );
    }
}
function travel(kind: "undo" | "redo" | "discard") {
  const workflow = getCurrentWorkflow();
  const history = historyOf(workflow);
  const result =
    kind === "undo"
      ? undoHistory(history, snapshotOf(workflow))
      : kind === "redo"
        ? redoHistory(history, snapshotOf(workflow))
        : discardHistory(history);
  if (!result) return;
  perform("Could not restore board changes", async () => {
    await restore(workflow, result.snapshot);
    histories.set(workflow.id, result.history);
    changedHistory();
  });
}
export const undo = () => travel("undo");
export const redo = () => travel("redo");
export const discardChanges = () => travel("discard");
export function recordHistoryStep() {
  const workflow = getCurrentWorkflow();
  histories.set(workflow.id, recordHistory(historyOf(workflow), snapshotOf(workflow)));
  changedHistory();
}
export function setCurrentWorkflow(id: string) {
  const workflow = getWorkflow(id);
  if (!workflow) return;
  histories.set(id, createHistory(snapshotOf(workflow)));
  setState({ currentId: id });
}
export function createNewWorkflow(name?: string, settings?: WorkflowSettings) {
  const id = randomUUID();
  const finalName = uniqueWorkflowName(
    getSnapshot()?.workflows.map((w) => w.name) ?? [],
    name?.trim() || "Workflow",
  );
  perform("Could not create workflow", async () => {
    const workspaceId = getCurrentWorkflow()?.workspaceId ?? getSnapshot()?.workspaces[0]?.id;
    if (!workspaceId) throw new Error("Create a workspace first.");
    const workflow = await runBoardMutation((client) =>
      client.createWorkflow({
        headers: {},
        payload: { id, name: finalName, workspaceId, ...(settings ? { settings } : {}) },
      }),
    );
    setState({ currentId: workflow.id });
  });
}
export function createWorkflowIn(workspaceId: string, name: string) {
  const id = randomUUID();
  const finalName = uniqueWorkflowName(
    getSnapshot()?.workflows.map((w) => w.name) ?? [],
    name.trim() || "Workflow",
  );
  perform("Could not create workflow", async () => {
    const workflow = await runBoardMutation((client) =>
      client.createWorkflow({ headers: {}, payload: { id, name: finalName, workspaceId } }),
    );
    setCurrentWorkflow(workflow.id);
  });
}
export function createWorkspace(name: string) {
  perform("Could not create workspace", async () => {
    const workspace = await runBoardMutation((client) =>
      client.createWorkspace({ headers: {}, payload: { id: randomUUID(), name: name.trim() } }),
    );
    createWorkflowIn(workspace.id, "Workflow");
  });
}
export function renameWorkspace(id: string, name: string) {
  perform("Could not rename workspace", () =>
    runBoardMutation((client) =>
      client.updateWorkspace({
        headers: {},
        params: { workspaceId: id },
        payload: { name: name.trim() },
      }),
    ),
  );
}
export function removeWorkspace(
  id: string,
  removeFolders: ReadonlyArray<{ environmentId: EnvironmentId; path: string }> = [],
) {
  perform("Could not delete workspace", () =>
    runBoardMutation((client) =>
      client.deleteWorkspace({
        headers: {},
        params: { workspaceId: id },
        payload: removeFolders.length > 0 ? { removeFolders } : {},
      }),
    ),
  );
}
export function addWorkspaceFolder(
  workspaceId: string,
  environmentId: EnvironmentId,
  path?: string,
) {
  perform("Could not add folder", () =>
    runBoardMutation((client) =>
      client.addFolder({
        headers: {},
        params: { workspaceId },
        payload: { environmentId, ...(path?.trim() ? { path: path.trim() } : {}) },
      }),
    ),
  );
}
export function removeWorkspaceFolder(workspaceId: string, environmentId: EnvironmentId) {
  perform("Could not remove folder", () =>
    runBoardMutation((client) =>
      client.deleteFolder({ headers: {}, params: { workspaceId, environmentId } }),
    ),
  );
}
export function duplicateWorkflow(id: string) {
  const source = getSnapshot()?.workflows.find((w) => w.id === id);
  if (source) createNewWorkflow(`${source.name} copy`, source.settings);
}
export function removeWorkflow(id: string) {
  const isLast = !getSnapshot()?.workflows.some((workflow) => workflow.id !== id);
  perform("Could not remove workflow", async () => {
    await runBoardMutation((client) =>
      client.deleteWorkflow({ headers: {}, params: { workflowId: id } }),
    );
    histories.delete(id);
    if (isLast) createNewWorkflow();
  });
}
export function renameWorkflow(id: string, name: string) {
  perform("Could not rename workflow", () =>
    runBoardMutation((client) =>
      client.updateWorkflow({
        headers: {},
        params: { workflowId: id },
        payload: { name: name.trim() },
      }),
    ),
  );
}
const PLACEMENT_GAP = 16;
/** The first grid spot where a new agent of this profile clears every existing agent's circle box. */
export function nextNodePosition(
  workflow: Pick<Workflow, "nodes">,
  profile: CoreNode["profile"] = "worker",
) {
  const size = agentNodeSize({ profile });
  for (let index = 0; ; index++) {
    const x = 40 + (index % 4) * 300,
      y = 40 + Math.floor(index / 4) * 230;
    const clear = workflow.nodes.every((node) => {
      const other = agentNodeSize(node);
      return (
        x + size + PLACEMENT_GAP <= node.x ||
        node.x + other + PLACEMENT_GAP <= x ||
        y + size + PLACEMENT_GAP <= node.y ||
        node.y + other + PLACEMENT_GAP <= y
      );
    });
    if (clear) return { x, y };
  }
}
export async function createNode(workflowId: string, input: BoardCreateNodeInput) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("Workflow is not available.");
  const history = recordHistory(historyOf(workflow), snapshotOf(workflow));
  await runBoardMutation((client) =>
    client.createNode({ headers: {}, params: { workflowId }, payload: input }),
  );
  histories.set(workflowId, history);
  changedHistory();
}
export async function configureNode(id: string, patch: BoardUpdateNodeInput) {
  const workflow = getCurrentWorkflow();
  const history = recordHistory(historyOf(workflow), snapshotOf(workflow));
  await runBoardMutation((client) =>
    client.updateNode({
      headers: {},
      params: { workflowId: workflow.id, nodeId: id },
      payload: patch,
    }),
  );
  histories.set(workflow.id, history);
  changedHistory();
}
function patchNode(id: string, patch: { name?: string; prompt?: string; x?: number; y?: number }) {
  const action = (workflow: Workflow) =>
    runBoardMutation((client) =>
      client.updateNode({
        headers: {},
        params: { workflowId: workflow.id, nodeId: id },
        payload: patch,
      }),
    );
  edit(action);
}
export async function updateNode(id: string, patch: { x?: number; y?: number; size?: number }) {
  const workflow = getCurrentWorkflow();
  try {
    await runBoardMutation((client) =>
      client.updateNode({
        headers: {},
        params: { workflowId: workflow.id, nodeId: id },
        payload: patch,
      }),
    );
    return true;
  } catch (error) {
    reportError("Could not update agent", error);
    return false;
  }
}
/** Puts the workflow's kanban on the board, moves it, or (null) takes it off; every viewer sees it. */
export async function placeKanban(placement: KanbanPlacement | null) {
  const workflow = getCurrentWorkflow();
  try {
    await runBoardMutation((client) =>
      client.updateWorkflow({
        headers: {},
        params: { workflowId: workflow.id },
        payload: { kanban: placement },
      }),
    );
    return true;
  } catch (error) {
    reportError("Could not update the kanban", error);
    return false;
  }
}
/** Launches the node's own chat thread if it has none; the snapshot event then carries it. */
export async function openNodeChat(id: string) {
  const workflow = getCurrentWorkflow();
  try {
    await runBoardMutation((client) =>
      client.openNodeChat({ headers: {}, params: { workflowId: workflow.id, nodeId: id } }),
    );
    return true;
  } catch (error) {
    reportError("Could not open the chat", error);
    return false;
  }
}
/** Gives the node a fresh chat thread, with the chat's current settings, in place of the one it shows. */
export async function newNodeChat(id: string, settings: BoardNewNodeChatInput) {
  const workflow = getCurrentWorkflow();
  try {
    await runBoardMutation((client) =>
      client.newNodeChat({
        headers: {},
        params: { workflowId: workflow.id, nodeId: id },
        payload: settings,
      }),
    );
    return true;
  } catch (error) {
    reportError("Could not start a new chat", error);
    return false;
  }
}
/** The agent's schedule lives on its machine; these calls go through the hub, which keeps it in step. */
export function saveNodeSchedule(nodeId: string, input: BoardSaveNodeScheduleInput) {
  const workflowId = getCurrentWorkflow().id;
  return runBoardMutation((client) =>
    client.saveNodeSchedule({ headers: {}, params: { workflowId, nodeId }, payload: input }),
  );
}
export function setNodeScheduleEnabled(nodeId: string, enabled: boolean) {
  const workflowId = getCurrentWorkflow().id;
  return runBoardMutation((client) =>
    client.setNodeScheduleEnabled({
      headers: {},
      params: { workflowId, nodeId },
      payload: { enabled },
    }),
  );
}
export function deleteNodeSchedule(nodeId: string) {
  const workflowId = getCurrentWorkflow().id;
  return runBoardMutation((client) =>
    client.deleteNodeSchedule({ headers: {}, params: { workflowId, nodeId } }),
  );
}
/** Moves the node's chat to the thread a "new chat" firing started while the board was away. */
export function syncNodeSchedule(nodeId: string) {
  const workflowId = getCurrentWorkflow().id;
  perform("Could not follow the scheduled chat", () =>
    runBoardApi((client) =>
      client.syncNodeSchedule({ headers: {}, params: { workflowId, nodeId } }),
    ),
  );
}
export function renameNode(id: string, name: string) {
  if (name.trim()) patchNode(id, { name: name.trim() });
}
export function removeNode(id: string) {
  edit((workflow) =>
    runBoardMutation((client) =>
      client.deleteNode({ headers: {}, params: { workflowId: workflow.id, nodeId: id } }),
    ),
  );
}
export function addEdge(a: string, b: string) {
  const workflow = getCurrentWorkflow();
  if (
    a === b ||
    workflow.edges.some((edge) => (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a))
  )
    return;
  edit((current) =>
    runBoardMutation((client) =>
      client.createEdge({ headers: {}, params: { workflowId: current.id }, payload: { a, b } }),
    ),
  );
}
export function removeEdge(a: string, b: string) {
  edit((workflow) =>
    runBoardMutation((client) =>
      client.deleteEdge({ headers: {}, params: { workflowId: workflow.id, fromId: a, toId: b } }),
    ),
  );
}
