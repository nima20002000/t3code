import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BoardStore from "./BoardStore.ts";
import * as TaskEngine from "./TaskEngine.ts";
import { Scheduler } from "./upstream.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const store = yield* BoardStore.BoardStore;
    const engine = yield* TaskEngine.TaskEngine;
    const runDue = Effect.fn("BoardScheduler.runDue")(function* () {
      const currentTime = DateTime.toEpochMillis(yield* DateTime.now);
      const schedules = yield* store.listSchedules();
      for (const schedule of schedules) {
        const { id } = schedule;
        const dueAt = schedule.nextRunAt;
        if (!schedule.enabled || !dueAt || Date.parse(dueAt) > currentTime) continue;
        const claim = Effect.gen(function* () {
          const current = (yield* store.listSchedules()).find((entry) => entry.id === id);
          if (!current?.enabled || current.nextRunAt !== dueAt || Date.parse(dueAt) > currentTime)
            return false;
          const nextRunAt = DateTime.formatIso(
            DateTime.makeUnsafe(
              Math.max(Date.parse(dueAt) + current.everyMs, currentTime + current.everyMs),
            ),
          );
          const updated = { ...current, nextRunAt };
          yield* store.putSchedule(updated);
          yield* store.appendEvent({ kind: "schedule.upserted", schedule: updated });
          const workflow = yield* store.getWorkflow(current.workflowId);
          if (workflow?.runs.some((run) => run.status === "running" || run.status === "stopping")) {
            yield* Effect.logInfo("Board schedule skipped because a run is active", {
              scheduleId: id,
              dueAt,
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
