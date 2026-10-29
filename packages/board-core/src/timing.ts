import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  PositiveInt,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * When a board schedule fires: t3's interval and time-of-day schedules, plus a one-off at a moment.
 * Agent schedules run as t3 tasks on their machine; workflow schedules run on the hub. Both turn a
 * timing into t3's schedule with `taskScheduleOf` and take the next run from t3's own function.
 */
export const BoardTimingSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS)),
  }),
  Schema.Struct({
    type: Schema.Literal("fixed_time"),
    timeOfDay: Schema.String.check(Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/)),
    /** 0 is Sunday; unset means every day. */
    weekdays: Schema.optionalKey(
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("once"),
    at: Schema.String.check(Schema.makeFilter((value) => Option.isSome(DateTime.make(value)))),
  }),
]);
export type BoardTiming = typeof BoardTimingSchema.Type;

/** How many more times a schedule fires; unset means no limit. A one-off fires once. */
export const BoardScheduleRuns = PositiveInt;

export interface TaskSchedule {
  readonly schedule: Extract<ScheduledTaskSchedule, { readonly type: "interval" | "fixed_time" }>;
  readonly startAt?: string;
  readonly runs?: number;
}

/** A one-off is any schedule that starts at its moment and runs once. */
export function taskScheduleOf(timing: BoardTiming, runs: number | undefined): TaskSchedule {
  if (timing.type === "once")
    return {
      schedule: { type: "interval", everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS },
      startAt: DateTime.formatIso(DateTime.makeUnsafe(timing.at)),
      runs: 1,
    };
  return runs === undefined ? { schedule: timing } : { schedule: timing, runs };
}

/** The timing a t3 task written by `taskScheduleOf` stands for. */
export function timingOfTask(task: {
  readonly schedule: ScheduledTaskSchedule;
  readonly startAt?: string | undefined;
}): BoardTiming | null {
  if (task.startAt !== undefined) return { type: "once", at: task.startAt };
  const schedule = task.schedule;
  if (schedule.type === "webhook") return null;
  if (schedule.type === "interval") return { type: "interval", everyMs: schedule.everyMs };
  return {
    type: "fixed_time",
    timeOfDay: schedule.timeOfDay,
    ...(schedule.weekdays === undefined ? {} : { weekdays: schedule.weekdays }),
  };
}
