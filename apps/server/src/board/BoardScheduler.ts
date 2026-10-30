import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as TaskEngine from "./TaskEngine.ts";
import { boardNow, missedBoardRun, nextBoardRunAt } from "./boardTiming.ts";
import { Scheduler } from "./upstream.ts";

/** The run id prefix of a schedule's runs, so a run can find the one before it. */
const scheduleRunPrefix = (scheduleId: string) =>
  `board:schedule:${encodeURIComponent(scheduleId)}:`;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const store = yield* BoardStore.BoardStore;
    const engine = yield* TaskEngine.TaskEngine;
    const drivers = yield* DriverRegistry.DriverRegistry;
    // Due runs held back for busy work: late on purpose, so never counted as missed.
    const held = new Set<string>();

    /** A run of the workflow, or any agent's chat in its workspace folders, is still working. */
    const busy = Effect.fn("BoardScheduler.busy")(function* (workflowId: string) {
      const workflow = yield* store.getWorkflow(workflowId);
      if (!workflow) return false;
      if (workflow.runs.some((run) => run.status === "running" || run.status === "stopping"))
        return true;
      const workspace = yield* store.getWorkspace(workflow.workspaceId);
      const machines = new Set(workflow.nodes.map((node) => node.environmentId));
      for (const folder of workspace?.folders ?? []) {
        if (!machines.has(folder.environmentId)) continue;
        const active = yield* drivers.get(folder.environmentId).pipe(
          Effect.flatMap((driver) =>
            driver.projectBusy({
              environmentId: folder.environmentId,
              projectId: folder.projectId,
            }),
          ),
          // An unreachable machine runs nothing the board could wait for.
          Effect.orElseSucceed(() => false),
        );
        if (active) return true;
      }
      return false;
    });

    const runDue = Effect.fn("BoardScheduler.runDue")(function* () {
      const now = yield* boardNow;
      const currentTime = DateTime.toEpochMillis(now);
      const schedules = yield* store.listSchedules();
      for (const schedule of schedules) {
        const { id } = schedule;
        const dueAt = schedule.nextRunAt;
        if (!schedule.enabled || !dueAt || Date.parse(dueAt) > currentTime) continue;
        const key = `${id}\0${dueAt}`;
        if (yield* busy(schedule.workflowId)) {
          if (!held.has(key))
            yield* Effect.logInfo("Board schedule waits for the workflow's agents", {
              scheduleId: id,
              dueAt,
            });
          held.add(key);
          continue;
        }
        const wasHeld = held.delete(key);
        const claim = Effect.gen(function* () {
          const current = (yield* store.listSchedules()).find((entry) => entry.id === id);
          if (!current?.enabled || current.nextRunAt !== dueAt || Date.parse(dueAt) > currentTime)
            return false;
          const skipped = !wasHeld && missedBoardRun(current.timing, dueAt, now);
          // Only a run that starts uses up one of the schedule's runs.
          const runCount = current.runCount + (skipped ? 0 : 1);
          const counted = { ...current, runCount };
          const nextRunAt = nextBoardRunAt(counted, now);
          const used = current.maxRuns !== undefined && runCount >= current.maxRuns;
          const updated = { ...counted, nextRunAt, enabled: current.enabled && !used };
          yield* store.putSchedule(updated);
          yield* store.appendEvent({ kind: "schedule.upserted", schedule: updated });
          if (skipped) {
            yield* Effect.logInfo("Board schedule skipped a run missed while the hub was off", {
              scheduleId: id,
              dueAt,
            });
            return false;
          }
          return true;
        });
        const prefix = scheduleRunPrefix(id);
        yield* engine
          .startClaimed(
            schedule.workflowId,
            { id: `${prefix}${encodeURIComponent(dueAt)}`, task: schedule.task },
            claim,
            schedule.chats === "continue" ? { continueRunsOf: prefix } : {},
          )
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
