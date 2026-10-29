import type {
  BoardNodeScheduleBeforeRun,
  BoardSaveNodeScheduleInput,
} from "@t3tools/board-core/http";
import type { ScheduledTask } from "@t3tools/contracts";

export interface ScheduleSummary {
  readonly state: "active" | "paused" | "done";
  /** Null when the task has no run limit. */
  readonly runsLeft: number | null;
  readonly nextRunAt: string | null;
}

/** Read from t3's task on the machine, so runs it fired while the hub was off count too. */
export function scheduleSummary(
  task: Pick<ScheduledTask, "enabled" | "runCount" | "maxRuns" | "nextRunAt">,
): ScheduleSummary {
  const runsLeft = task.maxRuns === undefined ? null : Math.max(0, task.maxRuns - task.runCount);
  return {
    state: runsLeft === 0 ? "done" : task.enabled ? "active" : "paused",
    runsLeft,
    nextRunAt: task.enabled && runsLeft !== 0 ? task.nextRunAt : null,
  };
}

export function scheduleLabel(summary: ScheduleSummary): string {
  if (summary.state === "done") return "Done";
  const left = summary.runsLeft === null ? null : `${summary.runsLeft} left`;
  if (summary.state === "paused") return left ? `Paused · ${left}` : "Paused";
  const next = summary.nextRunAt === null ? null : nextLabel(summary.nextRunAt);
  return [left, next].filter((part) => part !== null).join(" · ");
}

function nextLabel(at: string): string {
  return new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export interface ScheduleForm {
  readonly prompt: string;
  readonly mode: "interval" | "time";
  readonly minutes: string;
  readonly timeOfDay: string;
  /** 0 is Sunday; empty means every day. */
  readonly weekdays: ReadonlyArray<number>;
  readonly runs: string;
  readonly beforeRun: BoardNodeScheduleBeforeRun;
}

export function formOf(task: ScheduledTask | null): ScheduleForm {
  const summary = task ? scheduleSummary(task) : null;
  return {
    prompt: task?.prompt ?? "",
    mode: task?.schedule.type === "fixed_time" ? "time" : "interval",
    minutes: task?.schedule.type === "interval" ? String(task.schedule.everyMs / 60_000) : "60",
    timeOfDay: task?.schedule.type === "fixed_time" ? task.schedule.timeOfDay : "09:00",
    weekdays: task?.schedule.type === "fixed_time" ? (task.schedule.weekdays ?? []) : [],
    runs: summary?.runsLeft ? String(summary.runsLeft) : "3",
    // Compacting keeps what the agent learned while each firing starts from a small context.
    beforeRun: task === null ? "compact" : (task.beforeRun ?? "none"),
  };
}

/** The save request, or null while the form is incomplete. */
export function scheduleInput(form: ScheduleForm): BoardSaveNodeScheduleInput | null {
  const prompt = form.prompt.trim();
  const runs = Number(form.runs);
  if (prompt.length === 0 || !Number.isSafeInteger(runs) || runs < 1) return null;
  const common = { prompt, runs, beforeRun: form.beforeRun };
  if (form.mode === "time") {
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(form.timeOfDay)) return null;
    return {
      ...common,
      timing: {
        type: "fixed_time",
        timeOfDay: form.timeOfDay,
        ...(form.weekdays.length === 0
          ? {}
          : { weekdays: form.weekdays.toSorted((a, b) => a - b) }),
      },
    };
  }
  const everyMs = Math.round(Number(form.minutes) * 60_000);
  if (!Number.isSafeInteger(everyMs) || everyMs < 60_000) return null;
  return { ...common, timing: { type: "interval", everyMs } };
}
