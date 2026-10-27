import { runToShow, runViews, type NodeRunView } from "@t3tools/board-core/runView";

import { useNodeConnections } from "../useNodeConnection";
import { useBoardPeers, type BoardNode, type Workflow } from "../boardStore";
import { useEnvironmentIdentities, useThreadShells } from "../upstream";

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export interface NodeCardInfo {
  readonly node: BoardNode;
  readonly view: NodeRunView;
  readonly machine: string;
  readonly model: string | null;
  readonly instanceId: string | null;
}

/** The same node states the canvas shows, from the drawn run and each node's live thread. */
export function useNodeRunViews(workflow: Pick<Workflow, "nodes" | "edges" | "runs">) {
  const connectionOf = useNodeConnections();
  const threads = useThreadShells();
  return runViews(runToShow(workflow.runs), workflow.nodes, workflow.edges, (node) => {
    const shell = threads.find(
      (thread) => thread.environmentId === node.environmentId && thread.id === node.threadId,
    );
    return {
      connection: connectionOf(node.environmentId),
      turnActive: shell !== undefined && ACTIVE_STATUSES.has(shell.source.status),
    };
  });
}

export function useNodeCards(workflow: Pick<Workflow, "nodes" | "edges" | "runs">): NodeCardInfo[] {
  const environments = useEnvironmentIdentities();
  const peers = useBoardPeers();
  const threads = useThreadShells();
  const views = useNodeRunViews(workflow);
  return workflow.nodes.map((node) => {
    const shell = threads.find(
      (thread) => thread.environmentId === node.environmentId && thread.id === node.threadId,
    );
    return {
      node,
      view: views.nodes.get(node.id) ?? { state: "idle", label: "Idle" },
      machine:
        environments.find((environment) => environment.environmentId === node.environmentId)
          ?.label ??
        peers.find((peer) => peer.environmentId === node.environmentId)?.name ??
        "Unknown",
      model: shell?.modelSelection.model ?? null,
      instanceId: shell ? String(shell.modelSelection.instanceId) : null,
    };
  });
}
