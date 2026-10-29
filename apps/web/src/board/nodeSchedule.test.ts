import { describe, expect, it } from "vite-plus/test";

import { formOf, scheduleInput } from "./nodeSchedule";
import { scheduleLabel, scheduleSummary } from "./scheduleTiming";

const task = (patch: Partial<Parameters<typeof scheduleSummary>[0]>) => ({
  enabled: true,
  runCount: 0,
  nextRunAt: "2026-01-01T10:00:00.000Z",
  ...patch,
});

describe("scheduleSummary", () => {
  it("counts runs that fired unwatched and ends when they are used up", () => {
    expect(scheduleSummary(task({ maxRuns: 5, runCount: 2 }))).toMatchObject({
      state: "active",
      runsLeft: 3,
    });
    expect(scheduleSummary(task({ maxRuns: 5, runCount: 2, enabled: false }))).toMatchObject({
      state: "paused",
      runsLeft: 3,
      nextRunAt: null,
    });
    const done = scheduleSummary(task({ maxRuns: 2, runCount: 2 }));
    expect(done).toMatchObject({ state: "done", runsLeft: 0, nextRunAt: null });
    expect(scheduleLabel(done)).toBe("Done");
    expect(scheduleSummary(task({})).runsLeft).toBeNull();
  });
});

describe("scheduleInput", () => {
  it("builds an interval, a time of day or a one-off, and refuses what t3 would reject", () => {
    const form = { ...formOf(null), prompt: " Check mail " };
    expect(form.beforeRun).toBe("compact");
    const timing = (patch: Partial<typeof form.timing>) =>
      scheduleInput({ ...form, timing: { ...form.timing, ...patch } });
    expect(timing({ minutes: "2" })).toEqual({
      prompt: "Check mail",
      runs: 3,
      beforeRun: "compact",
      timing: { type: "interval", everyMs: 120_000 },
    });
    expect(timing({ minutes: "2", runs: "" })).not.toHaveProperty("runs");
    expect(timing({ minutes: "0.5" })).toBeNull();
    expect(timing({ runs: "0" })).toBeNull();
    expect(
      timing({ mode: "time", timeOfDay: "07:15", weekdays: [5, 1], runs: "1" })?.timing,
    ).toEqual({ type: "fixed_time", timeOfDay: "07:15", weekdays: [1, 5] });
    expect(timing({ mode: "time", timeOfDay: "25:00" })).toBeNull();
    const once = timing({ mode: "once", date: "2026-12-24T18:30" });
    expect(once?.timing.type).toBe("once");
    expect(once).not.toHaveProperty("runs");
    expect(timing({ mode: "once", date: "" })).toBeNull();
  });
});
