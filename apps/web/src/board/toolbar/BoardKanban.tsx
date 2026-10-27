import { KANBAN_STATUSES, type KanbanStatus } from "@t3tools/board-core/kanban";

import { useKanbanCards, type Workflow } from "../boardStore";

const LABELS: Record<KanbanStatus, string> = {
  todo: "To do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

/** The workflow's persisted kanban: cards the orchestrator maintains, by status. */
export function BoardKanban(props: { readonly workflow: Workflow }) {
  const cards = useKanbanCards(props.workflow.id);
  const nameOf = (nodeId: string | undefined) =>
    props.workflow.nodes.find((node) => node.id === nodeId)?.name;
  return (
    <section
      className="absolute inset-0 box-border bg-background px-4 pt-19 pb-4"
      aria-label="Kanban"
    >
      <div className="grid h-full auto-cols-fr grid-flow-col gap-2">
        {KANBAN_STATUSES.map((status) => {
          const column = cards.filter((card) => card.status === status);
          return (
            <div
              key={status}
              className="board-kanban-column flex min-h-0 min-w-0 flex-col gap-2 overflow-auto rounded-lg p-2.5"
              data-status={status}
            >
              <h3 className="text-sm break-words">
                {LABELS[status]}{" "}
                <small className="font-normal text-muted-foreground">{column.length}</small>
              </h3>
              {column.map((card) => {
                const assignee = nameOf(card.assigneeNodeId);
                return (
                  <article
                    key={card.id}
                    className="grid gap-1 rounded-lg border border-border bg-card px-2.5 py-2 text-xs text-foreground"
                  >
                    <strong className="break-words">{card.title}</strong>
                    {card.body ? (
                      <p className="break-words whitespace-pre-wrap text-muted-foreground">
                        {card.body}
                      </p>
                    ) : null}
                    {card.status === "blocked" && card.reason ? (
                      <p className="break-words text-destructive-foreground">{card.reason}</p>
                    ) : null}
                    {assignee ? <small className="text-muted-foreground">{assignee}</small> : null}
                  </article>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
