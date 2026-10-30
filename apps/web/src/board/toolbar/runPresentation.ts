import type { RunRecord, RunStatus } from "@t3tools/board-core/boardModel";

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: "Running",
  stopping: "Stopping",
  finished: "Finished",
  stopped: "Stopped",
  failed: "Failed",
};

const RUN_STATUS_DOT: Record<RunStatus, string> = {
  running: "bg-info",
  stopping: "bg-muted-foreground",
  finished: "bg-success",
  stopped: "bg-warning",
  failed: "bg-destructive",
};

/** Why the engine keeps retrying this run's machines, one line per node; empty once it stopped. */
export function retryReasons(run: RunRecord): ReadonlyArray<string> {
  return run.status === "running" ? Object.values(run.retrying ?? {}) : [];
}

export function runStatusLabel(run: RunRecord): string {
  return retryReasons(run).length > 0 ? "Retrying" : RUN_STATUS_LABELS[run.status];
}

export function runStatusDot(run: RunRecord): string {
  return retryReasons(run).length > 0 ? "bg-warning" : RUN_STATUS_DOT[run.status];
}

export function formatRunTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
