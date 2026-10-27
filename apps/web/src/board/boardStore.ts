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
}

export interface BoardEdge {
  readonly a: string;
  readonly b: string;
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
}

const EMPTY_STATE: BoardState = { nodes: [], edges: [], pending: [], log: [] };

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

export function addNode(input: Pick<BoardNode, "name" | "environmentId" | "threadId">) {
  const offset = state.nodes.length * 30;
  const node: BoardNode = {
    ...input,
    id: randomUUID(),
    x: 40 + offset,
    y: 40 + offset,
    baselined: false,
  };
  setState({ ...state, nodes: [...state.nodes, node] });
}

export function updateNode(id: string, patch: Partial<Pick<BoardNode, "x" | "y" | "baselined">>) {
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
  return state.edges.some((edge) => (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a));
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
