import { CommandId, MessageId, type RunId } from "@t3tools/contracts";

/** t3's own ids for continuing a cut run (RestartContinuation.ts), so its continuation and ours are one. */
export const continuationIds = (runId: RunId) => ({
  commandId: CommandId.make(`command:restart-continuation:${runId}`),
  messageId: MessageId.make(`message:restart-continuation:${runId}`),
});

export const CONTINUE_TEXT = "Continue where you left off.";

/** The run that now carries a cut run's work: the end of its restart continuation chain. */
export function latestContinuation<
  Run extends { readonly id: RunId; readonly restartContinuationOfRunId?: RunId | undefined },
>(runs: ReadonlyArray<Run>, run: Run): Run {
  let current = run;
  for (let hops = 0; hops < runs.length; hops++) {
    const next = runs.find((candidate) => candidate.restartContinuationOfRunId === current.id);
    if (next === undefined) break;
    current = next;
  }
  return current;
}
