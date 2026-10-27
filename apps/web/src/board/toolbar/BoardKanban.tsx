import { Tooltip, TooltipPopup, TooltipTrigger } from "../upstream";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";

import type { Workflow } from "../boardStore";
import type { NodeRunState } from "@t3tools/board-core/runView";
import { useNodeCards } from "./useNodeStatuses";
import { buildThreadRouteParams } from "../upstream";

const COLUMNS: ReadonlyArray<{
  readonly status: string;
  readonly label: string;
  readonly states: ReadonlyArray<NodeRunState>;
}> = [
  { status: "working", label: "Working", states: ["running", "queued"] },
  { status: "waiting", label: "Waiting", states: ["waiting"] },
  { status: "done", label: "Done", states: ["completed"] },
  { status: "failed", label: "Failed", states: ["failed"] },
  { status: "idle", label: "Idle", states: ["idle"] },
  { status: "disconnected", label: "Offline", states: ["unavailable"] },
];

/** Foreman-style kanban of the workflow's agents by status; a card opens its thread. */
export function BoardKanban(props: { readonly workflow: Workflow }) {
  const navigate = useNavigate();
  const cards = useNodeCards(props.workflow);
  return (
    <section
      className="absolute inset-0 box-border bg-background px-4 pt-19 pb-4"
      aria-label="Kanban"
    >
      <div className="grid h-full auto-cols-fr grid-flow-col gap-2">
        {COLUMNS.map((column) => {
          const columnCards = cards.filter((card) => column.states.includes(card.view.state));
          return (
            <div
              key={column.status}
              className="board-kanban-column flex min-h-0 min-w-0 flex-col gap-2 overflow-auto rounded-lg p-2.5"
              data-status={column.status}
            >
              <h3 className="text-sm break-words">
                {column.label}{" "}
                <small className="font-normal text-muted-foreground">{columnCards.length}</small>
              </h3>
              {columnCards.map(({ node, view, machine, model, instanceId }) => (
                <Tooltip key={node.id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="grid gap-0.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left text-xs text-foreground hover:border-ring"
                        onClick={() =>
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: buildThreadRouteParams(
                              scopeThreadRef(node.environmentId, node.threadId),
                            ),
                          })
                        }
                      >
                        <strong>{node.name}</strong>
                        <span className="break-words text-muted-foreground">{view.label}</span>
                        <span className="break-words text-muted-foreground">{machine}</span>
                        <small className="break-words text-muted-foreground">
                          {[instanceId, model].filter(Boolean).join(" / ") || "Thread not found"}
                        </small>
                      </button>
                    }
                  />
                  <TooltipPopup>{`Open ${node.name} thread`}</TooltipPopup>
                </Tooltip>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
