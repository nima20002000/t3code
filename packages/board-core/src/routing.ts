import type { BoardEdge, BoardNode, PendingWake, RunRecord, Workflow } from "./boardModel.ts";
import { matchNodeName, type BoardResult, type WorkRequest } from "./resultProtocol.ts";

export type GraphProblem =
  | { readonly kind: "duplicate-node-id"; readonly nodeId: string }
  | { readonly kind: "duplicate-node-name"; readonly name: string }
  | { readonly kind: "invalid-edge"; readonly edge: BoardEdge }
  | { readonly kind: "duplicate-edge"; readonly edge: BoardEdge }
  | { readonly kind: "several-orchestrators" }
  | { readonly kind: "no-orchestrator" };

export function validateGraph(
  graph: Pick<Workflow, "nodes" | "edges">,
): ReadonlyArray<GraphProblem> {
  const problems: GraphProblem[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) problems.push({ kind: "duplicate-node-id", nodeId: node.id });
    ids.add(node.id);
    const name = node.name.trim().toLowerCase();
    if (names.has(name)) problems.push({ kind: "duplicate-node-name", name: node.name });
    names.add(name);
  }
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.a === edge.b || !ids.has(edge.a) || !ids.has(edge.b)) {
      problems.push({ kind: "invalid-edge", edge });
    }
    const key = JSON.stringify([edge.a, edge.b].sort());
    if (edges.has(key)) problems.push({ kind: "duplicate-edge", edge });
    edges.add(key);
  }
  if (graph.nodes.filter((node) => node.profile === "orchestrator").length > 1)
    problems.push({ kind: "several-orchestrators" });
  return problems;
}

/** What a run needs on top of a valid graph: workers need exactly one orchestrator to hand them work. */
export function validateRunnable(
  graph: Pick<Workflow, "nodes" | "edges">,
): ReadonlyArray<GraphProblem> {
  const problems = [...validateGraph(graph)];
  const hasWorkers = graph.nodes.some((node) => node.profile === "worker");
  if (hasWorkers && !graph.nodes.some((node) => node.profile === "orchestrator"))
    problems.push({ kind: "no-orchestrator" });
  return problems;
}

export interface SettledMessage {
  readonly id: string;
  readonly role: string;
  readonly streaming: boolean;
  readonly text: string;
}

export function selectSettledMessages<T extends SettledMessage>(
  messages: ReadonlyArray<T>,
  processed: ReadonlySet<string>,
): { readonly fresh: ReadonlyArray<T>; readonly latest: T | undefined } {
  const fresh = messages.filter(
    (message) => message.role === "assistant" && !message.streaming && !processed.has(message.id),
  );
  return { fresh, latest: fresh.at(-1) };
}

export function canHandoff(
  limit: number | null,
  requests: ReadonlyArray<RunRecord["requests"][number]>,
  fromId: string,
  toId: string,
  additionalAccepted = 0,
): boolean {
  return (
    limit === null ||
    requests.filter(
      (request) =>
        request.fromId === fromId && request.toId === toId && request.status !== "denied",
    ).length +
      additionalAccepted <
      limit
  );
}

export type RoutingAction =
  | { readonly kind: "request"; readonly target: BoardNode; readonly request: WorkRequest }
  | {
      readonly kind: "denied";
      readonly target: BoardNode;
      readonly request: WorkRequest;
      readonly limit: number;
    }
  | { readonly kind: "return"; readonly pending: PendingWake; readonly result: BoardResult }
  | { readonly kind: "finish"; readonly runId: string | undefined; readonly result: BoardResult }
  | { readonly kind: "ignore-briefing" };

export type RoutingDecision =
  | { readonly ok: true; readonly actions: ReadonlyArray<RoutingAction> }
  | { readonly ok: false; readonly reason: string };

export function decideRouting(
  result: BoardResult,
  workflow: Workflow,
  nodeId: string,
  pending: ReadonlyArray<PendingWake> = workflow.pending,
  options: { readonly briefing?: boolean } = {},
): RoutingDecision {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return { ok: false, reason: `unknown node "${nodeId}"` };
  const run = workflow.runs.find((candidate) => candidate.status === "running");
  const routing = result.routing;
  if (options.briefing && routing.kind === "request" && !run) {
    return { ok: true, actions: [{ kind: "ignore-briefing" }] };
  }
  if (routing.kind !== "request") {
    const incoming = pending.filter((entry) => entry.to === nodeId);
    let match: PendingWake | undefined;
    if (routing.kind === "return" && routing.requestId !== undefined) {
      match = incoming.find((entry) => entry.id === routing.requestId);
      if (!match)
        return { ok: false, reason: `unknown requestId "${routing.requestId}" for ${node.name}` };
    } else if (incoming.length === 1) {
      match = incoming[0];
    } else if (routing.kind === "return" || incoming.length > 1) {
      return {
        ok: false,
        reason:
          incoming.length === 0
            ? "you have no pending request to return"
            : "requestId is required because several requests are pending",
      };
    }
    if (match) return { ok: true, actions: [{ kind: "return", pending: match, result }] };
    return {
      ok: true,
      actions: [{ kind: "finish", runId: run?.nodeId === nodeId ? run.id : undefined, result }],
    };
  }

  const reachable = workflow.nodes.filter(
    (candidate) =>
      candidate.id !== nodeId &&
      workflow.edges.some((edge) => edge.a === nodeId && edge.b === candidate.id),
  );
  const targets: Array<{ target: BoardNode; request: WorkRequest }> = [];
  for (const request of routing.requests) {
    const name = matchNodeName(
      reachable.map((candidate) => candidate.name),
      request.to,
    );
    const target = reachable.find((candidate) => candidate.name === name);
    if (!target)
      return { ok: false, reason: `"${request.to}" is not a node you can send requests to` };
    targets.push({ target, request });
  }
  const limit = workflow.settings.maxHandoffsPerEdge;
  const accepted = new Map<string, number>();
  const actions: RoutingAction[] = [];
  for (const { target, request } of targets) {
    if (
      limit !== null &&
      !canHandoff(limit, run?.requests ?? [], nodeId, target.id, accepted.get(target.id) ?? 0)
    ) {
      actions.push({ kind: "denied", target, request, limit });
    } else {
      accepted.set(target.id, (accepted.get(target.id) ?? 0) + 1);
      actions.push({ kind: "request", target, request });
    }
  }
  return { ok: true, actions };
}
