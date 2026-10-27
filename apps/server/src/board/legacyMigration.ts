import type {
  BoardNode,
  RunRecord,
  Workflow,
  WorkflowSettings,
  Workspace,
  WorkspaceFolder,
} from "@t3tools/board-core";
import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";

/** Board migration 3: today's fixed-thread workflows become one default workspace of profile nodes. */

export const DEFAULT_WORKSPACE_ID = "workspace:default";

interface LegacyNode {
  readonly id: string;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly x: number;
  readonly y: number;
  readonly role?: string;
}

export interface LegacyWorkflow extends Omit<
  Workflow,
  "nodes" | "runs" | "workspaceId" | "settings"
> {
  readonly nodes: ReadonlyArray<LegacyNode>;
  readonly runs: ReadonlyArray<Omit<RunRecord, "threads" | "definition">>;
  readonly settings: WorkflowSettings;
}

/**
 * The orchestrator is the entry node of the newest run when it hands out work, else the first node
 * that hands out work, else the first node. Every other node is a worker.
 */
function orchestratorId(workflow: LegacyWorkflow): string | undefined {
  const handsOut = new Set(workflow.edges.map((edge) => edge.a));
  const newest = workflow.runs.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (newest && handsOut.has(newest.nodeId)) return newest.nodeId;
  return (workflow.nodes.find((node) => handsOut.has(node.id)) ?? workflow.nodes[0])?.id;
}

/** One folder per machine: the project most nodes of that machine used. The path is unknown here. */
function foldersOf(workflows: ReadonlyArray<LegacyWorkflow>): ReadonlyArray<WorkspaceFolder> {
  const counts = new Map<EnvironmentId, Map<ProjectId, number>>();
  for (const workflow of workflows)
    for (const node of workflow.nodes) {
      if (!node.projectId) continue;
      const projects = counts.get(node.environmentId) ?? new Map<ProjectId, number>();
      projects.set(node.projectId, (projects.get(node.projectId) ?? 0) + 1);
      counts.set(node.environmentId, projects);
    }
  return [...counts].map(([environmentId, projects]) => ({
    environmentId,
    projectId: [...projects].toSorted((a, b) => b[1] - a[1])[0]![0],
    path: "",
    managed: false,
  }));
}

export function upgradeLegacyBoard(
  legacy: ReadonlyArray<LegacyWorkflow>,
  endedAt: string,
): { readonly workspace: Workspace; readonly workflows: ReadonlyArray<Workflow> } {
  const workflows = legacy.map((workflow): Workflow => {
    const orchestrator = orchestratorId(workflow);
    const modelSelection = {
      instanceId: workflow.settings.defaultInstanceId,
      model: workflow.settings.defaultModel,
    } as ModelSelection;
    const nodes = workflow.nodes.map((node): BoardNode => ({
      id: node.id,
      name: node.name,
      profile: node.id === orchestrator ? "orchestrator" : "worker",
      environmentId: node.environmentId,
      modelSelection,
      ...(node.role?.trim() ? { prompt: node.role } : {}),
      x: node.x,
      y: node.y,
    }));
    const definition = { nodes, edges: workflow.edges, settings: workflow.settings };
    return {
      ...workflow,
      workspaceId: DEFAULT_WORKSPACE_ID,
      nodes,
      pending: [],
      runQueue: [],
      runs: workflow.runs.map((run): RunRecord => ({
        ...run,
        // Fixed threads are gone, so a run that was still going cannot continue.
        ...(run.status === "running" ? { status: "stopped" as const, endedAt } : {}),
        requests: run.requests.map((request) =>
          request.status === "pending" && run.status === "running"
            ? { ...request, status: "stopped" as const, returnedAt: endedAt }
            : request,
        ),
        threads: {},
        definition,
      })),
    };
  });
  return {
    workspace: {
      id: DEFAULT_WORKSPACE_ID,
      name: "Default workspace",
      folders: foldersOf(legacy),
    },
    workflows,
  };
}
