import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as BoardStore from "./BoardStore.ts";
import * as TaskEngine from "./TaskEngine.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const store = yield* BoardStore.BoardStore;
    const engine = yield* TaskEngine.TaskEngine;
    const runDue = Effect.fn("BoardScheduler.runDue")(function* () {
      const currentTime = DateTime.toEpochMillis(yield* DateTime.now);
      const schedules = yield* store.listSchedules();
      for (const schedule of schedules) {
        if (
          !schedule.enabled ||
          schedule.nextRunAt === null ||
          Date.parse(schedule.nextRunAt) > currentTime
        )
          continue;
        const dueAt = schedule.nextRunAt;
        const runId = `board:schedule:${encodeURIComponent(schedule.id)}:${encodeURIComponent(dueAt)}`;
        const started = yield* engine
          .start(schedule.workflowId, { id: runId, nodeId: schedule.nodeId, task: schedule.task })
          .pipe(
            Effect.as(true),
            Effect.catchTags({ BoardConflictError: () => Effect.succeed(true) }),
            Effect.catch((cause) =>
              Effect.logWarning("Board schedule could not start", {
                scheduleId: schedule.id,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
        if (!started) continue;
        yield* store.transaction(
          Effect.gen(function* () {
            const current = (yield* store.listSchedules()).find(
              (entry) => entry.id === schedule.id,
            );
            if (!current?.enabled || current.nextRunAt !== dueAt) return;
            const nextRunAt = DateTime.formatIso(
              DateTime.makeUnsafe(
                Math.max(Date.parse(dueAt) + current.everyMs, currentTime + current.everyMs),
              ),
            );
            const updated = { ...current, nextRunAt };
            yield* store.putSchedule(updated);
            yield* store.appendEvent({ kind: "schedule.upserted", schedule: updated });
          }),
        );
      }
    });
    yield* scheduler.register("board", runDue());
  }),
).pipe(Layer.provide(Scheduler.layer));
