import type { BoardEdge, BoardNode, RunRecord, RunRequestRecord } from "./boardModel.ts";

/** What the canvas shows for a node; matches the Foreman node states the board styles. */
export type NodeRunState =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "unavailable";

export interface NodeRunView {
  readonly state: NodeRunState;
  readonly label: string;
}

/** A fact crossing an edge: a request going out (task), its return coming home, or a failure. */
export type EdgeSignal = "task" | "return" | "error";

export interface EdgeRunView {
  /** Requests on this edge still waiting for their return. */
  readonly pending: number;
  /** The colour of the lasting trace, from the newest fact on the edge. */
  readonly signal?: EdgeSignal;
  /** One entry per fact; a new key is a new crossing to animate once. */
  readonly crossings: ReadonlyArray<{
    readonly key: string;
    readonly signal: EdgeSignal;
    readonly at: string;
  }>;
}

export interface NodeLiveFacts {
  /** The node's machine: connected, reconnecting (a blip, such as a restart), or offline. */
  readonly connection: "connected" | "reconnecting" | "offline";
  /** The node's thread has a turn in progress. */
  readonly turnActive: boolean;
}

const edgeKey = (from: string, to: string) => `${from}:${to}`;
const isActive = (run: RunRecord) => run.status === "running" || run.status === "stopping";
const FAILED: ReadonlySet<RunRequestRecord["status"]> = new Set(["failed", "denied", "dropped"]);

function waitingLabel(outgoing: ReadonlyArray<RunRequestRecord>): string {
  const open = outgoing.filter((request) => request.status === "pending");
  if (open.length === 1) return `Waiting for ${open[0]!.to}`;
  return `Waiting for ${outgoing.length - open.length} of ${outgoing.length} returns`;
}

/** The run to draw: the active one, else the newest by start time. */
export function runToShow(runs: ReadonlyArray<RunRecord>): RunRecord | undefined {
  return (
    runs.find(isActive) ??
    runs.reduce<RunRecord | undefined>(
      (newest, run) => (newest && newest.startedAt >= run.startedAt ? newest : run),
      undefined,
    )
  );
}

/**
 * Projects one run record and each node's live thread facts into node words and edge signals.
 * Pure: the engine's records are the facts; this only decides how they read on the canvas.
 */
export function runViews<N extends BoardNode>(
  run: RunRecord | undefined,
  nodes: ReadonlyArray<N>,
  edges: ReadonlyArray<BoardEdge>,
  live: (node: N) => NodeLiveFacts,
): { nodes: Map<string, NodeRunView>; edges: Map<string, EdgeRunView> } {
  const nodeViews = new Map<string, NodeRunView>();
  const requests = run?.requests ?? [];
  const active = run !== undefined && isActive(run);

  for (const node of nodes) {
    const facts = live(node);
    const incoming = requests.filter((request) => request.toId === node.id);
    const outgoing = requests.filter((request) => request.fromId === node.id);
    // The newest attempt of a request decides; a node can be asked again after returning.
    const current = incoming.at(-1);
    const isEntry = run?.nodeId === node.id;
    const inRun = run !== undefined && (isEntry || incoming.length > 0);
    const openOut = outgoing.some((request) => request.status === "pending");

    let view: NodeRunView;
    if (facts.connection === "reconnecting")
      view = { state: "unavailable", label: "Reconnecting…" };
    else if (facts.connection === "offline")
      view = { state: "unavailable", label: "Machine offline" };
    else if (!inRun) view = facts.turnActive ? { state: "running", label: "Working" } : IDLE;
    else if (active && run.status === "stopping")
      view = facts.turnActive
        ? { state: "waiting", label: "Stopping" }
        : { state: "idle", label: "Stopped" };
    else if (active && (isEntry || current?.status === "pending")) {
      const from = isEntry ? undefined : current?.from;
      view = facts.turnActive
        ? { state: "running", label: from ? `Working for ${from}` : "Working" }
        : openOut
          ? { state: "waiting", label: waitingLabel(outgoing) }
          : { state: "queued", label: from ? `Starting · from ${from}` : "Starting" };
    } else if (isEntry) view = entryOutcome(run!);
    else if (current && FAILED.has(current.status))
      view = {
        state: "failed",
        label: current.failureReason ? "Request failed" : `Request ${current.status}`,
      };
    else if (current?.status === "stopped") view = { state: "idle", label: "Stopped" };
    else if (current?.status === "returned") view = { state: "completed", label: "Returned" };
    else view = IDLE;
    nodeViews.set(node.id, view);
  }

  const edgeViews = new Map<string, EdgeRunView>();
  for (const edge of edges) {
    const onEdge = requests.filter(
      (request) => request.fromId === edge.a && request.toId === edge.b,
    );
    const crossings: Array<{ key: string; signal: EdgeSignal; at: string }> = [];
    for (const request of onEdge) {
      crossings.push({ key: `${request.id}:task`, signal: "task", at: request.at });
      if (request.status === "returned")
        crossings.push({
          key: `${request.id}:return`,
          signal: "return",
          at: request.returnedAt ?? request.at,
        });
      else if (FAILED.has(request.status))
        crossings.push({
          key: `${request.id}:error`,
          signal: "error",
          at: request.returnedAt ?? request.at,
        });
    }
    crossings.sort((left, right) => left.at.localeCompare(right.at));
    edgeViews.set(edgeKey(edge.a, edge.b), {
      pending: active ? onEdge.filter((request) => request.status === "pending").length : 0,
      ...(active && crossings.length ? { signal: crossings.at(-1)!.signal } : {}),
      crossings,
    });
  }
  return { nodes: nodeViews, edges: edgeViews };
}

const IDLE: NodeRunView = { state: "idle", label: "Idle" };

function entryOutcome(run: RunRecord): NodeRunView {
  switch (run.status) {
    case "finished":
      return { state: "completed", label: "Finished" };
    case "failed":
      return { state: "failed", label: "Run failed" };
    default:
      return { state: "idle", label: "Stopped" };
  }
}
