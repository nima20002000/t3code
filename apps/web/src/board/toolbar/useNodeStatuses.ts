import { useThreadShells } from "../../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { useBoardPeers, type BoardNode, type Workflow } from "../boardStore";

export type NodeStatus = "idle" | "working" | "waiting" | "disconnected";

export interface NodeCardInfo {
  readonly node: BoardNode;
  readonly status: NodeStatus;
  readonly machine: string;
  readonly model: string | null;
  readonly instanceId: string | null;
}

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** Live status of every node of a workflow: disconnected machine, working turn, waiting for a return, or idle. */
export function useNodeCards(workflow: Pick<Workflow, "nodes" | "pending">): NodeCardInfo[] {
  const connectedIds = useConnectedEnvironmentIds();
  const environments = useEnvironmentIdentities();
  const peers = useBoardPeers();
  const threads = useThreadShells();
  return workflow.nodes.map((node) => {
    const shell = threads.find(
      (thread) => thread.environmentId === node.environmentId && thread.id === node.threadId,
    );
    const status: NodeStatus = !connectedIds.includes(node.environmentId)
      ? "disconnected"
      : shell && ACTIVE_STATUSES.has(shell.source.status)
        ? "working"
        : workflow.pending.some((wake) => wake.from === node.id)
          ? "waiting"
          : "idle";
    return {
      node,
      status,
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
