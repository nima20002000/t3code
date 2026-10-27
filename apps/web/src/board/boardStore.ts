import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { randomUUID } from "../lib/utils";

const BOARD_STORAGE_KEY = "t3.board.v1";
const PROCESSED_STORAGE_KEY = "t3.board.processed.v1";
const MAX_LOG = 200;
const MAX_PROCESSED = 2000;

export interface BoardNode {
  readonly id: string;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly x: number;
  readonly y: number;
  /** True once the messages that existed when the node was added were marked processed. */
  readonly baselined: boolean;
  /** Set for agents the board started: their first reply answers the setup prompt and is skipped. */
  readonly awaitingFirstReply?: boolean;
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
  readonly kind: "wake" | "result" | "info";
  readonly text: string;
}

export interface BoardState {
  readonly nodes: ReadonlyArray<BoardNode>;
  readonly edges: ReadonlyArray<BoardEdge>;
  readonly pending: ReadonlyArray<PendingWake>;
  readonly log: ReadonlyArray<BoardLogEntry>;
  readonly runQueue: ReadonlyArray<RunRequest>;
}

const EMPTY_STATE: BoardState = { nodes: [], edges: [], pending: [], log: [], runQueue: [] };

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

let state: BoardState = { ...EMPTY_STATE, ...readJson<Partial<BoardState>>(BOARD_STORAGE_KEY, {}) };
let processed: ReadonlySet<string> = new Set(readJson<string[]>(PROCESSED_STORAGE_KEY, []));
const listeners = new Set<() => void>();

function setState(next: BoardState) {
  state = next;
  writeJson(BOARD_STORAGE_KEY, state);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getBoardState(): BoardState {
  return state;
}

export function useBoardState(): BoardState {
  return useSyncExternalStore(subscribe, getBoardState, getBoardState);
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

export function addNode(
  input: Pick<BoardNode, "name" | "environmentId" | "threadId"> &
    Partial<Pick<BoardNode, "baselined" | "awaitingFirstReply">>,
): string {
  const { x, y } = nextFreeSlot(state.nodes);
  const node: BoardNode = {
    baselined: false,
    ...input,
    id: randomUUID(),
    x,
    y,
  };
  setState({ ...state, nodes: [...state.nodes, node] });
  return node.id;
}

export function updateNode(
  id: string,
  patch: Partial<Pick<BoardNode, "x" | "y" | "baselined" | "awaitingFirstReply">>,
) {
  setState({
    ...state,
    nodes: state.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
  });
}

export function removeNode(id: string) {
  setState({
    ...state,
    nodes: state.nodes.filter((node) => node.id !== id),
    edges: state.edges.filter((edge) => edge.a !== id && edge.b !== id),
    pending: state.pending.filter((wake) => wake.from !== id && wake.to !== id),
  });
}

export function areConnected(a: string, b: string): boolean {
  return state.edges.some(
    (edge) => (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a),
  );
}

/** True when a saved edge lets `from` send work requests to `to`. */
export function canRequest(from: string, to: string): boolean {
  return state.edges.some((edge) => edge.a === from && edge.b === to);
}

/** Queues a workflow run; the engine sends `task` to the entry node and clears the request. */
export function requestRun(nodeId: string, task: string) {
  setState({ ...state, runQueue: [...state.runQueue, { id: randomUUID(), nodeId, task }] });
}

export function clearRunRequest(id: string) {
  setState({ ...state, runQueue: state.runQueue.filter((run) => run.id !== id) });
}

export function addEdge(a: string, b: string): boolean {
  if (a === b || areConnected(a, b)) return false;
  setState({ ...state, edges: [...state.edges, { a, b }] });
  return true;
}

export function removeEdge(a: string, b: string) {
  if (!areConnected(a, b)) return;
  setState({
    ...state,
    edges: state.edges.filter(
      (edge) => !((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a)),
    ),
  });
}

export function toggleEdge(a: string, b: string) {
  if (a === b) return;
  setState({
    ...state,
    edges: areConnected(a, b)
      ? state.edges.filter(
          (edge) => !((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a)),
        )
      : [...state.edges, { a, b }],
  });
}

export function addPending(wake: PendingWake) {
  setState({ ...state, pending: [...state.pending, wake] });
}

export function removePending(id: string) {
  setState({ ...state, pending: state.pending.filter((wake) => wake.id !== id) });
}

export function appendLog(kind: BoardLogEntry["kind"], text: string) {
  const entry: BoardLogEntry = { id: randomUUID(), at: new Date().toISOString(), kind, text };
  setState({ ...state, log: [entry, ...state.log].slice(0, MAX_LOG) });
}
