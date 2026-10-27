import type { BoardEvent, BoardSnapshot } from "@t3tools/board-core/http";

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
                runs: w.runs.some((run) => run.id === event.run.id)
                  ? upsert(w.runs, event.run)
                  : [event.run, ...w.runs],
              }
            : w,
        ),
      };
  }
}
