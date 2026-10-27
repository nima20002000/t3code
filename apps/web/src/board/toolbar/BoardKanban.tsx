import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";

import { buildThreadRouteParams } from "../../threadRoutes";
import type { Workflow } from "../boardStore";
import { useNodeCards, type NodeStatus } from "./useNodeStatuses";

const COLUMNS: ReadonlyArray<{ readonly status: NodeStatus; readonly label: string }> = [
  { status: "idle", label: "Idle" },
  { status: "working", label: "Working" },
  { status: "waiting", label: "Waiting for return" },
  { status: "disconnected", label: "Disconnected" },
];

/** Foreman-style kanban of the workflow's agents by status; a card opens its thread. */
export function BoardKanban(props: { readonly workflow: Workflow }) {
  const navigate = useNavigate();
  const cards = useNodeCards(props.workflow);
  return (
    <section className="board-kanban" aria-label="Kanban">
      <div className="board-kanban-columns">
        {COLUMNS.map((column) => {
          const columnCards = cards.filter((card) => card.status === column.status);
          return (
            <div key={column.status} className="board-kanban-column" data-status={column.status}>
              <h3>
                {column.label} <small>{columnCards.length}</small>
              </h3>
              {columnCards.map(({ node, machine, model, instanceId }) => (
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
