import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { maxRunsAfter, missedBoardRun, nextBoardRunAt } from "./boardTiming.ts";

const at = (iso: string) => DateTime.makeZonedUnsafe(iso, { timeZone: "UTC" });
const schedule = {
  enabled: true,
  runCount: 0,
  timing: { type: "fixed_time" as const, timeOfDay: "09:00", weekdays: [1, 3] },
};

it("a time of day picks the next listed weekday", () => {
  // 2026-10-29 is a Thursday: the next Monday or Wednesday 09:00 is Monday 2 November.
  assert.strictEqual(
    nextBoardRunAt(schedule, at("2026-10-29T10:00:00.000Z")),
    "2026-11-02T09:00:00.000Z",
  );
  assert.strictEqual(
    nextBoardRunAt(schedule, at("2026-11-02T08:59:00.000Z")),
    "2026-11-02T09:00:00.000Z",
  );
  assert.isTrue(
    missedBoardRun(schedule.timing, "2026-11-02T09:00:00.000Z", at("2026-11-02T10:00:00.000Z")),
  );
});

it("a one-off fires at its moment once, and a limit ends a schedule", () => {
  const once = { type: "once" as const, at: "2026-12-24T18:30:00.000Z" };
  const maxRuns = maxRunsAfter(once, 0, undefined);
  assert.strictEqual(maxRuns, 1);
  const pending = { enabled: true, runCount: 0, timing: once, maxRuns: 1 };
  assert.strictEqual(
    nextBoardRunAt(pending, at("2026-10-29T10:00:00.000Z")),
    "2026-12-24T18:30:00.000Z",
  );
  assert.isNull(nextBoardRunAt({ ...pending, runCount: 1 }, at("2026-12-24T18:30:05.000Z")));

  const interval = { type: "interval" as const, everyMs: 300_000 };
  assert.strictEqual(maxRunsAfter(interval, 4, 2), 6);
  assert.isUndefined(maxRunsAfter(interval, 4, undefined));
  const limited = { enabled: true, runCount: 5, timing: interval, maxRuns: 6 };
  assert.strictEqual(
    nextBoardRunAt(limited, at("2026-10-29T10:00:00.000Z")),
    "2026-10-29T10:05:00.000Z",
  );
  assert.isNull(nextBoardRunAt({ ...limited, runCount: 6 }, at("2026-10-29T10:00:00.000Z")));
});
