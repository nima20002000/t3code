import { useAtomValue } from "@effect/atom-react";
import {
  type BoardCreateNodeInput,
  type BoardPeer,
  type BoardSchedule,
  type BoardSnapshot,
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
  type History,
  type Workflow,
  type WorkflowSettings,
} from "@t3tools/board-core/boardModel";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShells } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import {
  boardHubOrigin,
  readBoardHubEnvironmentId,
  runBoardApi,
  runBoardMutation,
  streamBoardEvents,
} from "./boardApi";
import { applyBoardEvent } from "./boardState";
import { importLocalWorkflows } from "./boardImport";

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
} from "@t3tools/board-core/boardModel";

interface BoardState {
  readonly snapshot: BoardSnapshot | null;
  readonly currentId: string;
  readonly status: "loading" | "connected" | "offline";
  readonly error: string | null;
  readonly importError: string | null;
  readonly historyVersion: number;
}

export const boardStateAtom = Atom.make<BoardState>({
  snapshot: null,
  currentId: "",
  status: "loading",
  error: null,
  importError: null,
  historyVersion: 0,
}).pipe(Atom.withLabel("board-hub-state"));
const histories = new Map<string, History>();
const getState = () => appAtomRegistry.get(boardStateAtom);
const setState = (patch: Partial<BoardState>) =>
  appAtomRegistry.set(boardStateAtom, { ...getState(), ...patch });
const getSnapshot = () => getState().snapshot;

function setSnapshot(snapshot: BoardSnapshot) {
  const previous = getState();
  const currentId = snapshot.workflows.some((w) => w.id === previous.currentId)
    ? previous.currentId
    : (snapshot.workflows[0]?.id ?? "");
  setState({ snapshot, currentId, status: "connected", error: null });
}

async function importToHub(snapshot: BoardSnapshot, signal?: AbortSignal) {
  await importLocalWorkflows({
    storage: localStorage,
    origin: boardHubOrigin(),
    snapshot,
    newId: randomUUID,
    projectIdForNode: (node) =>
      readThreadShells().find(
        (shell) => shell.environmentId === node.environmentId && shell.id === node.threadId,
      )?.projectId,
    send: (workflows) =>
      runBoardMutation(
        (client) => client.importWorkflows({ headers: {}, payload: { workflows } }),
        signal,
      ),
  });
}

export async function retryBoardImport() {
  const snapshot = getSnapshot();
  if (!snapshot) return;
  try {
    await importToHub(snapshot);
    setState({ importError: null });
  } catch (error) {
    setState({ importError: error instanceof Error ? error.message : String(error) });
  }
}

export function useBoardConnection() {
  // oxlint-disable-next-line t3code/react-effect-budget -- Keep the hub stream connected while the board is open.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        let snapshot = await runBoardApi(
          (client) => client.getSnapshot({ headers: {} }),
          controller.signal,
        );
        const hubId = readBoardHubEnvironmentId();
        const canMutate = hubId !== null && readEnvironmentScope(hubId, "orchestration:operate");
        try {
          if (canMutate) await importToHub(snapshot, controller.signal);
          if (!controller.signal.aborted) setState({ importError: null });
        } catch (error) {
          if (controller.signal.aborted) return;
          setState({ importError: error instanceof Error ? error.message : String(error) });
        }
        snapshot = await runBoardApi(
          (client) => client.getSnapshot({ headers: {} }),
          controller.signal,
        );
        if (canMutate && !snapshot.workflows.length) {
          await runBoardApi(
            (client) =>
              client.createWorkflow({
                headers: {},
                payload: { id: randomUUID(), name: "Workflow" },
              }),
            controller.signal,
          );
          snapshot = await runBoardApi(
            (client) => client.getSnapshot({ headers: {} }),
            controller.signal,
          );
        }
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
  return { workflows: snapshot?.workflows ?? [], currentId };
}
export function getWorkflow(id: string): Workflow | undefined {
  return getSnapshot()?.workflows.find((workflow) => workflow.id === id);
}
export function getCurrentWorkflow(): Workflow {
  const { snapshot, currentId } = getState();
  return (snapshot?.workflows.find((w) => w.id === currentId) ?? snapshot?.workflows[0])!;
}
export function useCurrentWorkflow(): Workflow {
  const { snapshot, currentId } = useBoardState();
  return (snapshot?.workflows.find((w) => w.id === currentId) ?? snapshot?.workflows[0])!;
}
export const activeRunOf = (workflow: Workflow) =>
  workflow.runs.find((run) => run.status === "running" || run.status === "stopping");
export function useBoardPeers(): ReadonlyArray<BoardPeer> {
  return useBoardState().snapshot?.peers ?? [];
}
export function useBoardSchedules(): ReadonlyArray<BoardSchedule> {
  return useBoardState().snapshot?.schedules ?? [];
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
    dirty: !snapshotsEqual(snapshotOf(workflow), history.origin),
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
      const projectId =
        node.projectId ??
        readThreadShells().find(
          (shell) => shell.environmentId === node.environmentId && shell.id === node.threadId,
        )?.projectId;
      if (!projectId) throw new Error(`The project for ${node.name} is not available.`);
      await runBoardMutation((client) =>
        client.createNode({
          headers: {},
          params: { workflowId: workflow.id },
          payload: { kind: "bind", ...node, projectId },
        }),
      );
    } else {
      await runBoardMutation((client) =>
        client.updateNode({
          headers: {},
          params: { workflowId: workflow.id, nodeId: node.id },
          payload: { name: node.name, role: node.role ?? "", x: node.x, y: node.y },
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
  const workflow = getSnapshot()?.workflows.find((w) => w.id === id);
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
    const workflow = await runBoardMutation((client) =>
      client.createWorkflow({
        headers: {},
        payload: { id, name: finalName, ...(settings ? { settings } : {}) },
      }),
    );
    setState({ currentId: workflow.id });
  });
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
export function updateWorkflowSettings(patch: Partial<WorkflowSettings>) {
  const workflow = getCurrentWorkflow();
  perform("Could not update workflow settings", () =>
    runBoardMutation((client) =>
      client.updateWorkflow({
        headers: {},
        params: { workflowId: workflow.id },
        payload: { settings: { ...workflow.settings, ...patch } },
      }),
    ),
  );
}
export function isThreadOnBoard(environmentId: string, threadId: string) {
  return (
    getSnapshot()?.workflows.some((w) =>
      w.nodes.some((n) => n.environmentId === environmentId && n.threadId === threadId),
    ) ?? false
  );
}
export function nextNodePosition(workflow: Workflow) {
  for (let index = 0; ; index++) {
    const x = 40 + (index % 4) * 300,
      y = 40 + Math.floor(index / 4) * 230;
    if (!workflow.nodes.some((node) => Math.abs(node.x - x) < 300 && Math.abs(node.y - y) < 230))
      return { x, y };
  }
}
export async function createNode(workflowId: string, input: BoardCreateNodeInput) {
  const workflow = getSnapshot()?.workflows.find((w) => w.id === workflowId);
  if (!workflow) throw new Error("Workflow is not available.");
  const history = recordHistory(historyOf(workflow), snapshotOf(workflow));
  await runBoardMutation((client) =>
    input.kind === "bind"
      ? client.createNode({ headers: {}, params: { workflowId }, payload: input })
      : client.createNode({ headers: {}, params: { workflowId }, payload: input }),
  );
  histories.set(workflowId, history);
  changedHistory();
}
function patchNode(id: string, patch: { name?: string; role?: string; x?: number; y?: number }) {
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
export async function updateNode(id: string, patch: { x: number; y: number }) {
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
export function renameNode(id: string, name: string) {
  if (name.trim()) patchNode(id, { name: name.trim() });
}
export function setNodeRole(id: string, role: string) {
  patchNode(id, { role });
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
