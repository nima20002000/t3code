import { taskScheduleOf, type BoardSchedule, type BoardTiming } from "@t3tools/board-core";
import * as DateTime from "effect/DateTime";
import { TaskSchedule } from "./upstream.ts";

/** The hub's clock in its local zone, which time-of-day schedules are read in, as t3 does. */
export const boardNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

/** A workflow schedule's next run, from t3's own schedule function; null once its runs are used. */
export function nextBoardRunAt(
  schedule: Pick<BoardSchedule, "timing" | "maxRuns" | "runCount" | "enabled">,
  from: DateTime.DateTime,
): string | null {
  if (!schedule.enabled) return null;
  if (schedule.maxRuns !== undefined && schedule.runCount >= schedule.maxRuns) return null;
  const { schedule: taskSchedule, startAt } = taskScheduleOf(schedule.timing, undefined);
  const next = TaskSchedule.nextScheduledRunAtFrom(
    taskSchedule,
    from,
    startAt === undefined ? undefined : DateTime.makeUnsafe(startAt),
  );
  return next === null ? null : DateTime.formatIso(DateTime.toUtc(next));
}

/** A time-of-day run the hub slept through is skipped, as t3 skips them. */
export function missedBoardRun(timing: BoardTiming, dueAt: string, now: DateTime.DateTime) {
  return TaskSchedule.isMissedFixedTimeRun(
    taskScheduleOf(timing, undefined).schedule,
    DateTime.makeUnsafe(dueAt),
    now,
  );
}

/** The run limit after granting `runs` more from now; a one-off always has one left. */
export function maxRunsAfter(
  timing: BoardTiming,
  runCount: number,
  runs: number | undefined,
): number | undefined {
  const granted = taskScheduleOf(timing, runs).runs;
  return granted === undefined ? undefined : runCount + granted;
}
