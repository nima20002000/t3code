import type { BoardDriverSettled, BoardDriverThread } from "@t3tools/board-core/NodeDriver";
import type { MessageId, OrchestrationV2Run, RunId } from "@t3tools/contracts";

/**
 * How long a connected machine may take to continue a run its restart cut off. t3 dispatches the
 * continuation from its outbox within seconds of serving, but exposes no "recovery done" signal.
 */
export const CONTINUATION_GRACE_MS = 120_000;

type Status = BoardDriverSettled["status"];
const isSettled = (status: OrchestrationV2Run["status"]): status is Status =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

/**
 * Follows t3's restart continuations like the local `waitForThread`: a cut ("cancelled") run settles
 * only when its chain ends, under the message that started it. A cancelled run nobody continues
 * within the grace while connected settles as cancelled.
 */
export function makeRestartChain(thread: BoardDriverThread) {
  const carries = new Map<RunId, MessageId>();
  const continued = new Set<RunId>();
  const cut = new Map<RunId, { since: number; sequence: number }>();
  const delivered = new Map<RunId, Status>();
  const emit = (runId: RunId, status: Status, sequence: number): Array<BoardDriverSettled> => {
    if (delivered.get(runId) === status) return [];
    delivered.set(runId, status);
    return [{ thread, runId, messageId: carries.get(runId)!, status, sequence }];
  };
  return {
    observe: (
      run: OrchestrationV2Run,
      sequence: number,
      now: number,
    ): Array<BoardDriverSettled> => {
      const source = run.restartContinuationOfRunId;
      if (source !== undefined) {
        continued.add(source);
        cut.delete(source);
      }
      if (!carries.has(run.id))
        carries.set(
          run.id,
          (source === undefined ? undefined : carries.get(source)) ?? run.userMessageId,
        );
      if (!isSettled(run.status) || continued.has(run.id)) return [];
      // t3 only continues work that started, or a continuation that had not started yet.
      if (run.status !== "cancelled" || (run.startedAt === null && source === undefined))
        return emit(run.id, run.status, sequence);
      if (!delivered.has(run.id) && !cut.has(run.id)) cut.set(run.id, { since: now, sequence });
      return [];
    },
    /** A new connection restarts every grace: the machine may have been away. */
    connected: (now: number) => {
      for (const entry of cut.values()) entry.since = now;
    },
    expire: (now: number): Array<BoardDriverSettled> =>
      [...cut].flatMap(([runId, entry]) => {
        if (now - entry.since < CONTINUATION_GRACE_MS) return [];
        cut.delete(runId);
        return emit(runId, "cancelled", entry.sequence);
      }),
  };
}
