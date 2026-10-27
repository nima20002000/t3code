import { KANBAN_STATUSES, type KanbanStatus } from "@t3tools/board-core/kanban";
import { LayoutGridIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useKanbanCards, type Workflow } from "../boardStore";
import { FloatingPanel } from "../FloatingPanel";
import { Button } from "../upstream";
import { IconButton } from "./IconButton";

const LABELS: Record<KanbanStatus, string> = {
  todo: "To do",
  doing: "Doing",
  waiting_for_human: "Waiting for human",
  blocked: "Blocked",
  done: "Done",
};

/**
 * The workflow's kanban as a window over the board: cards the orchestrator keeps, by status. It shows
 * `runId`'s cards and every open card; done cards of earlier runs stay folded until asked for.
 */
export function BoardKanban(props: {
  readonly workflow: Workflow;
  readonly runId: string | null;
  /** A new value (a run starting) returns the kanban to its band at the bottom. */
  readonly dockKey: string | null;
  readonly onClose: () => void;
}) {
  const allCards = useKanbanCards(props.workflow.id);
  const [showEarlier, setShowEarlier] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const earlier = allCards.filter((card) => card.status === "done" && card.runId !== props.runId);
  const cards = showEarlier ? allCards : allCards.filter((card) => !earlier.includes(card));
  const nameOf = (nodeId: string | undefined) =>
    props.workflow.nodes.find((node) => node.id === nodeId)?.name;
  const moverName = (by: string) => (by === "engine" ? "board" : (nameOf(by) ?? "agent"));
  return (
    <FloatingPanel
      storageKey="board:kanban-panel"
      label="Kanban"
      className="right-3 bottom-3 left-3 h-[32%]"
      resetKey={props.dockKey}
      header={
        <>
          <LayoutGridIcon className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium">Kanban</span>
          <small className="text-xs text-muted-foreground">
            {props.runId ? "this run" : "all runs"}
          </small>
          <div className="flex-1" />
          {earlier.length > 0 ? (
            <Button size="xs" variant="ghost" onClick={() => setShowEarlier((value) => !value)}>
              {showEarlier ? "Hide earlier runs" : `Earlier runs (${earlier.length})`}
            </Button>
          ) : null}
          <IconButton label="Close kanban" onClick={props.onClose}>
            <XIcon size={15} />
          </IconButton>
        </>
      }
    >
      <div className="grid min-h-0 flex-1 auto-cols-fr grid-flow-col gap-2 overflow-x-auto p-2">
        {KANBAN_STATUSES.map((status) => {
          const column = cards.filter((card) => card.status === status);
          return (
            <section
              key={status}
              aria-label={LABELS[status]}
              className="board-kanban-column flex min-h-0 min-w-36 flex-col gap-1.5 overflow-auto rounded-lg p-2"
              data-status={status}
            >
              <h3 className="flex items-baseline gap-1.5 text-xs font-medium">
                {LABELS[status]}
                <small className="font-normal text-muted-foreground">{column.length}</small>
              </h3>
              {column.map((card) => {
                const assignee = nameOf(card.assigneeNodeId);
                const open = expanded.has(card.id);
                return (
                  <article key={card.id} className="rounded-md border bg-background text-xs">
                    <button
                      type="button"
                      aria-expanded={open}
                      className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left"
                      onClick={() => toggle(card.id)}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{card.title}</span>
                    </button>
                    {open ? (
                      <div className="grid gap-1 border-t px-2 py-1.5">
                        {card.body ? (
                          <p className="break-words whitespace-pre-wrap text-muted-foreground">
                            {card.body}
                          </p>
                        ) : null}
                        {assignee ? (
                          <small className="text-muted-foreground">{assignee}</small>
                        ) : null}
                        {card.reason ? (
                          <p className="break-words text-muted-foreground italic">{card.reason}</p>
                        ) : null}
                        {card.moves && card.moves.length > 0 ? (
                          <small className="text-2xs text-muted-foreground/80">
                            {card.moves.map((move) => LABELS[move.status]).join(" → ")} ·{" "}
                            {moverName(card.moves.at(-1)!.by)}
                          </small>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </FloatingPanel>
  );
}
