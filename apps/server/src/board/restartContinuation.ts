import type { RunId } from "@t3tools/contracts";

/** The run that now carries a cut run's work: the end of t3's restart continuation chain. */
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
