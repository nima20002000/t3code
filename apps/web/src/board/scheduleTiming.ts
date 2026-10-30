import type { BoardTiming } from "@t3tools/board-core/timing";
import type { ScheduledTask } from "@t3tools/contracts";

/** The timing fields both schedule editors share: the node's and the workflow's. */
export interface TimingForm {
  readonly mode: "interval" | "time" | "once";
  readonly minutes: string;
  readonly timeOfDay: string;
  /** 0 is Sunday; empty means every day. */
  readonly weekdays: ReadonlyArray<number>;
  /** A `datetime-local` value, in the browser's zone. */
  readonly date: string;
  /** Empty means no limit. A one-off fires once. */
  readonly runs: string;
}

export interface ScheduleSummary {
  readonly state: "active" | "paused" | "done";
  /** Null when the schedule has no run limit. */
  readonly runsLeft: number | null;
  readonly nextRunAt: string | null;
}

/** Read from the stored schedule, so runs fired while nobody watched count too. */
export function scheduleSummary(
  schedule: Pick<ScheduledTask, "enabled" | "runCount" | "maxRuns" | "nextRunAt">,
): ScheduleSummary {
  const runsLeft =
    schedule.maxRuns === undefined ? null : Math.max(0, schedule.maxRuns - schedule.runCount);
  return {
    state: runsLeft === 0 ? "done" : schedule.enabled ? "active" : "paused",
    runsLeft,
    nextRunAt: schedule.enabled && runsLeft !== 0 ? schedule.nextRunAt : null,
  };
}

export function scheduleLabel(summary: ScheduleSummary): string {
  if (summary.state === "done") return "Done";
  const left = summary.runsLeft === null ? null : `${summary.runsLeft} left`;
  if (summary.state === "paused") return left ? `Paused · ${left}` : "Paused";
  const next = summary.nextRunAt === null ? null : momentLabel(summary.nextRunAt);
  return [left, next].filter((part) => part !== null).join(" · ");
}

function momentLabel(at: string): string {
  return new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function timingLabel(timing: BoardTiming): string {
  if (timing.type === "interval") return `Every ${timing.everyMs / 60_000} min`;
  if (timing.type === "once")
    return `Once, ${new Date(timing.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  const days = timing.weekdays?.length
    ? timing.weekdays.map((day) => WEEKDAY_NAMES[day]).join(", ")
    : "daily";
  return `${timing.timeOfDay} ${days}`;
}

function localInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function timingFormOf(timing: BoardTiming | null, runs: string): TimingForm {
  return {
    mode: timing?.type === "fixed_time" ? "time" : timing?.type === "once" ? "once" : "interval",
    minutes: timing?.type === "interval" ? String(timing.everyMs / 60_000) : "60",
    timeOfDay: timing?.type === "fixed_time" ? timing.timeOfDay : "09:00",
    weekdays: timing?.type === "fixed_time" ? (timing.weekdays ?? []) : [],
    date: timing?.type === "once" ? localInputValue(timing.at) : "",
    runs,
  };
}

/** The timing and run limit, or null while the fields are incomplete. */
export function timingOf(
  form: TimingForm,
): { readonly timing: BoardTiming; readonly runs?: number } | null {
  if (form.mode === "once") {
    const at = Date.parse(form.date);
    return Number.isNaN(at) ? null : { timing: { type: "once", at: new Date(at).toISOString() } };
  }
  const trimmed = form.runs.trim();
  const runs = trimmed === "" ? undefined : Number(trimmed);
  if (runs !== undefined && (!Number.isSafeInteger(runs) || runs < 1)) return null;
  const limit = runs === undefined ? {} : { runs };
  if (form.mode === "time") {
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(form.timeOfDay)) return null;
    return {
      timing: {
        type: "fixed_time",
        timeOfDay: form.timeOfDay,
        ...(form.weekdays.length === 0
          ? {}
          : { weekdays: form.weekdays.toSorted((a, b) => a - b) }),
      },
      ...limit,
    };
  }
  const everyMs = Math.round(Number(form.minutes) * 60_000);
  if (!Number.isSafeInteger(everyMs) || everyMs < 60_000) return null;
  return { timing: { type: "interval", everyMs }, ...limit };
}
