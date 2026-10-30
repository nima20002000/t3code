import type {
  BoardNode as CoreNode,
  Workflow as CoreWorkflow,
} from "@t3tools/board-core/boardModel";
import type { BoardEvent, BoardSnapshot } from "@t3tools/board-core/http";
import type { ThreadId } from "@t3tools/contracts";

/**
 * A node's thread is the one its newest run launched for it, else its own chat thread. A node with
 * neither has none (an empty id matches no thread).
 */
export type BoardNode = CoreNode & { readonly threadId: ThreadId };
export type Workflow = Omit<CoreWorkflow, "nodes"> & { readonly nodes: ReadonlyArray<BoardNode> };

const NO_THREAD = "" as ThreadId;
const views = new WeakMap<object, Workflow>();
export function workflowView(workflow: CoreWorkflow): Workflow {
  const cached = views.get(workflow);
  if (cached) return cached;
  const newestFirst = workflow.runs.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
  const view: Workflow = {
    ...workflow,
    nodes: workflow.nodes.map((node) => ({
      ...node,
      threadId:
        newestFirst.find((run) => run.threads[node.id] !== undefined)?.threads[node.id]?.threadId ??
        node.chat?.threadId ??
        NO_THREAD,
    })),
  };
  views.set(workflow, view);
  return view;
}

export function applyBoardEvent(snapshot: BoardSnapshot, event: BoardEvent): BoardSnapshot {
  if (event.sequence <= snapshot.sequence) return snapshot;
  const upsert = <T extends { readonly id: string }>(
    items: ReadonlyArray<T>,
    item: T,
  ): ReadonlyArray<T> =>
    items.some((old) => old.id === item.id)
      ? items.map((old) => (old.id === item.id ? item : old))
      : [...items, item];
  switch (event.kind) {
    case "workspace.upserted":
      return {
        ...snapshot,
        sequence: event.sequence,
        workspaces: upsert(snapshot.workspaces, event.workspace),
      };
    case "workspace.deleted":
      return {
        ...snapshot,
        sequence: event.sequence,
        workspaces: snapshot.workspaces.filter((w) => w.id !== event.workspaceId),
      };
    case "kanban.upserted": {
      const known = snapshot.kanban.some((entry) => entry.workflowId === event.workflowId);
      const entries = known
        ? snapshot.kanban
        : [...snapshot.kanban, { workflowId: event.workflowId, cards: [] }];
      return {
        ...snapshot,
        sequence: event.sequence,
        kanban: entries.map((entry) =>
          entry.workflowId === event.workflowId
            ? { ...entry, cards: upsert(entry.cards, event.card) }
            : entry,
        ),
      };
    }
    case "kanban.deleted":
      return {
        ...snapshot,
        sequence: event.sequence,
        kanban: snapshot.kanban.map((entry) =>
          entry.workflowId === event.workflowId
            ? { ...entry, cards: entry.cards.filter((card) => card.id !== event.cardId) }
            : entry,
        ),
      };
    case "workflow.upserted":
      return {
        ...snapshot,
        sequence: event.sequence,
        workflows: upsert(snapshot.workflows, event.workflow),
      };
    case "workflow.deleted":
      return {
        ...snapshot,
        sequence: event.sequence,
        workflows: snapshot.workflows.filter((w) => w.id !== event.workflowId),
        kanban: snapshot.kanban.filter((entry) => entry.workflowId !== event.workflowId),
      };
    case "peer.upserted":
      return { ...snapshot, sequence: event.sequence, peers: upsert(snapshot.peers, event.peer) };
    case "peer.deleted":
      return {
        ...snapshot,
        sequence: event.sequence,
        peers: snapshot.peers.filter((p) => p.id !== event.peerId),
      };
    case "schedule.upserted":
      return {
        ...snapshot,
        sequence: event.sequence,
        schedules: upsert(snapshot.schedules, event.schedule),
      };
    case "schedule.deleted":
      return {
        ...snapshot,
        sequence: event.sequence,
        schedules: snapshot.schedules.filter((s) => s.id !== event.scheduleId),
      };
    case "run.upserted":
      return {
        ...snapshot,
        sequence: event.sequence,
        workflows: snapshot.workflows.map((w) =>
          w.id === event.workflowId
            ? {
                ...w,
                pending: event.pending ?? w.pending,
                runs: w.runs.some((run) => run.id === event.run.id)
                  ? upsert(w.runs, event.run)
                  : [...w.runs, event.run],
              }
            : w,
        ),
      };
  }
}

/** `base`, or `base 2`, `base 3`… — the first one no existing name uses (case-insensitive). */
export function nextFreeName(base: string, existing: ReadonlyArray<string>): string {
  const taken = new Set(existing.map((name) => name.trim().toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}
