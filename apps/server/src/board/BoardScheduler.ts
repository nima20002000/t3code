import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BoardStore from "./BoardStore.ts";
import * as TaskEngine from "./TaskEngine.ts";
import { boardNow, missedBoardRun, nextBoardRunAt } from "./boardTiming.ts";
import { Scheduler } from "./upstream.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const store = yield* BoardStore.BoardStore;
    const engine = yield* TaskEngine.TaskEngine;
    const runDue = Effect.fn("BoardScheduler.runDue")(function* () {
      const now = yield* boardNow;
      const currentTime = DateTime.toEpochMillis(now);
      const schedules = yield* store.listSchedules();
      for (const schedule of schedules) {
        const { id } = schedule;
        const dueAt = schedule.nextRunAt;
        if (!schedule.enabled || !dueAt || Date.parse(dueAt) > currentTime) continue;
        const claim = Effect.gen(function* () {
          const current = (yield* store.listSchedules()).find((entry) => entry.id === id);
          if (!current?.enabled || current.nextRunAt !== dueAt || Date.parse(dueAt) > currentTime)
            return false;
          const workflow = yield* store.getWorkflow(current.workflowId);
          const busy = workflow?.runs.some(
            (run) => run.status === "running" || run.status === "stopping",
          );
          const skipped = busy || missedBoardRun(current.timing, dueAt, now);
          // Only a run that starts uses up one of the schedule's runs.
          const runCount = current.runCount + (skipped ? 0 : 1);
          const counted = { ...current, runCount };
          const nextRunAt = nextBoardRunAt(counted, now);
          const used = current.maxRuns !== undefined && runCount >= current.maxRuns;
          const updated = { ...counted, nextRunAt, enabled: current.enabled && !used };
          yield* store.putSchedule(updated);
          yield* store.appendEvent({ kind: "schedule.upserted", schedule: updated });
          if (skipped) {
            yield* Effect.logInfo("Board schedule skipped a run", {
              scheduleId: id,
              dueAt,
              reason: busy ? "a run is active" : "missed while the hub was off",
            });
            return false;
          }
          return true;
        });
        const runId = `board:schedule:${encodeURIComponent(id)}:${encodeURIComponent(dueAt)}`;
        yield* engine
          .startClaimed(schedule.workflowId, { id: runId, task: schedule.task }, claim)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Board schedule could not start", { scheduleId: id, cause }),
            ),
          );
      }
    });
    yield* scheduler.register("board", runDue());
  }),
).pipe(Layer.provide(Scheduler.layer));
