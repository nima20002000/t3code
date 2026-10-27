import { MAX_LOG, migrateBoards } from "@t3tools/board-core/boardModel";
import { BoardWorkflowSchema, type BoardSnapshot } from "@t3tools/board-core/http";
import type { ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type Workflow = typeof BoardWorkflowSchema.Type;
const decodeWorkflows = Schema.decodeSync(Schema.Array(BoardWorkflowSchema));

export async function importLocalWorkflows(input: {
  readonly storage: Storage;
  readonly origin: string;
  readonly snapshot: BoardSnapshot;
  readonly newId: () => string;
  readonly projectIdForNode: (node: Workflow["nodes"][number]) => ProjectId | undefined;
  readonly send: (workflows: ReadonlyArray<Workflow>) => Promise<unknown>;
}) {
  const storageKey = `t3.board.imported.v3:${input.origin}`;
  if (input.storage.getItem(storageKey)) return;
  const raw = input.storage.getItem("t3.board.v2");
  const rawV1 = input.storage.getItem("t3.board.v1");
  if (raw !== null || rawV1 !== null) {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (
      parsed !== null &&
      (typeof parsed !== "object" || !Array.isArray((parsed as { workflows?: unknown }).workflows))
    ) {
      throw new Error("The local board data is invalid. It has not been imported or removed.");
    }
    const legacy: unknown = rawV1 === null ? null : JSON.parse(rawV1);
    const source = (parsed as { workflows?: unknown[] } | null)?.workflows ?? [];
    if (
      source.some(
        (workflow) =>
          typeof workflow !== "object" ||
          workflow === null ||
          typeof (workflow as { id?: unknown }).id !== "string",
      )
    ) {
      throw new Error("A local workflow is invalid. It has not been imported or removed.");
    }
    // A fixed id keeps a retried v1 import from creating a second workflow.
    const migrated = migrateBoards(parsed, legacy, () => "legacy-board-v1");
    const workflows =
      source.length === 0 && legacy === null ? [] : decodeWorkflows(migrated.workflows);
    const missing = workflows
      .filter(
        (workflow) => !input.snapshot.workflows.some((existing) => existing.id === workflow.id),
      )
      .map((workflow): Workflow => {
        const nodes = workflow.nodes.map((node) => {
          const projectId = node.projectId ?? input.projectIdForNode(node);
          if (!projectId) {
            throw new Error(
              `Connect the machine for ${node.name} in Settings → Connections, then retry the import.`,
            );
          }
          return { ...node, projectId };
        });
        if (
          !workflow.pending.length &&
          !workflow.runQueue.length &&
          !workflow.runs.some((run) => run.status === "running")
        )
          return { ...workflow, nodes };
        const at = new Date().toISOString();
        return {
          ...workflow,
          nodes,
          pending: [],
          runQueue: [],
          runs: workflow.runs.map((run) =>
            run.status !== "running"
              ? run
              : {
                  ...run,
                  status: "stopped",
                  endedAt: at,
                  requests: run.requests.map((request) =>
                    request.status === "pending" ? { ...request, status: "stopped" } : request,
                  ),
                },
          ),
          log: [
            {
              id: input.newId(),
              at,
              kind: "info" as const,
              text: "Unfinished local run tracking was stopped during import; queued work was not started.",
            },
            ...workflow.log,
          ].slice(0, MAX_LOG),
        };
      });
    if (missing.length) await input.send(missing);
  }
  input.storage.setItem(storageKey, "1");
}
