import { runToShow, runViews } from "@t3tools/board-core/runView";

import { useNodeConnections } from "../useNodeConnection";
import { type Workflow } from "../boardStore";
import { useThreadShells } from "../upstream";

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

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
