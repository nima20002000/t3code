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
    <section className="board-kanban" aria-label="Kanban">
      <div className="board-kanban-columns">
        {COLUMNS.map((column) => {
          const columnCards = cards.filter((card) => column.states.includes(card.view.state));
          return (
            <div key={column.status} className="board-kanban-column" data-status={column.status}>
              <h3>
                {column.label} <small>{columnCards.length}</small>
              </h3>
              {columnCards.map(({ node, view, machine, model, instanceId }) => (
                <button
                  key={node.id}
                  type="button"
                  className="board-kanban-card"
                  title={`Open ${node.name} thread`}
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
                  <span>{view.label}</span>
                  <span>{machine}</span>
                  <small>
                    {[instanceId, model].filter(Boolean).join(" / ") || "Thread not found"}
                  </small>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
