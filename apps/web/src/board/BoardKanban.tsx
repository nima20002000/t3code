import type { Node, NodeProps } from "@xyflow/react";
import type { KanbanPlacement } from "@t3tools/board-core/boardModel";
import { KANBAN_STATUSES, type KanbanStatus } from "@t3tools/board-core/kanban";
import { ClipboardListIcon } from "lucide-react";
import { useState } from "react";

import { placeKanban, useCurrentWorkflow, useKanbanCards } from "./boardStore";
import { BoardWindowFrame } from "./BoardWindows";
import { Button } from "./upstream";

const LABELS: Record<KanbanStatus, string> = {
  todo: "To do",
  doing: "Doing",
  waiting_for_human: "Waiting for human",
  blocked: "Blocked",
  done: "Done",
};

export const KANBAN_NODE_ID = ":kanban";

/** The workflow's kanban as an object on the canvas, placed where the workflow keeps it. */
export type KanbanFlowNode = Node<{ readonly runId: string | null }, "kanban">;

export const DEFAULT_KANBAN_SIZE = { width: 900, height: 320 } as const;

export function kanbanNode(
  placement: KanbanPlacement,
  runId: string | null,
  selected: boolean,
): KanbanFlowNode {
  return {
    id: KANBAN_NODE_ID,
    type: "kanban",
    position: { x: placement.x, y: placement.y },
    width: placement.width,
    height: placement.height,
    zIndex: 5,
    selected,
    dragHandle: ".board-window-header",
    data: { runId },
  };
}

/**
 * Cards the orchestrator keeps, by status. It shows `runId`'s cards and every open card; done
 * cards of earlier runs stay folded until asked for.
 */
export function BoardKanban({ data, selected }: NodeProps<KanbanFlowNode>) {
  const workflow = useCurrentWorkflow();
  const runId = data.runId;
  const allCards = useKanbanCards(workflow.id);
  const [showEarlier, setShowEarlier] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const earlier = allCards.filter((card) => card.status === "done" && card.runId !== runId);
  const cards = showEarlier ? allCards : allCards.filter((card) => !earlier.includes(card));
  const nameOf = (nodeId: string | undefined) =>
    workflow.nodes.find((node) => node.id === nodeId)?.name;
  const moverName = (by: string) => (by === "engine" ? "board" : (nameOf(by) ?? "agent"));
  return (
    <BoardWindowFrame
      id={KANBAN_NODE_ID}
      label="Kanban"
      selected={selected}
      canFullScreen={false}
      closeLabel="Remove kanban from board"
      onClose={() => void placeKanban(null)}
      title={
        <>
          <ClipboardListIcon className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium">Kanban</span>
          <small className="text-xs text-muted-foreground">{runId ? "this run" : "all runs"}</small>
        </>
      }
      actions={
        earlier.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={() => setShowEarlier((value) => !value)}>
            {showEarlier ? "Hide earlier runs" : `Earlier runs (${earlier.length})`}
          </Button>
        ) : null
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
    </BoardWindowFrame>
  );
}
