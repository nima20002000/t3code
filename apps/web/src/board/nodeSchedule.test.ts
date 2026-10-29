import { describe, expect, it } from "vite-plus/test";

import { formOf, scheduleInput, scheduleLabel, scheduleSummary } from "./nodeSchedule";

const task = (patch: Partial<Parameters<typeof scheduleSummary>[0]>) => ({
  enabled: true,
  runCount: 0,
  nextRunAt: "2026-01-01T10:00:00.000Z",
  ...patch,
});

describe("scheduleSummary", () => {
  it("counts runs the machine fired and ends when they are used up", () => {
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
  });
});

describe("scheduleInput", () => {
  it("builds an interval or a time of day, and refuses what t3 would reject", () => {
    const form = { ...formOf(null), prompt: " Check mail " };
    expect(form.beforeRun).toBe("compact");
    expect(scheduleInput({ ...form, minutes: "2" })).toEqual({
      prompt: "Check mail",
      runs: 3,
      beforeRun: "compact",
      timing: { type: "interval", everyMs: 120_000 },
    });
    expect(scheduleInput({ ...form, minutes: "0.5" })).toBeNull();
    expect(scheduleInput({ ...form, runs: "0" })).toBeNull();
    expect(
      scheduleInput({ ...form, mode: "time", timeOfDay: "07:15", weekdays: [5, 1], runs: "1" })
        ?.timing,
    ).toEqual({ type: "fixed_time", timeOfDay: "07:15", weekdays: [1, 5] });
    expect(scheduleInput({ ...form, mode: "time", timeOfDay: "25:00" })).toBeNull();
  });
});
