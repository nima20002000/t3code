import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

afterEach(() => vi.unstubAllEnvs());

const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Scheduler.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: () => Effect.die("synthetic dispatch failure"),
  }),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/projects",
    isScratchProject: () => Effect.succeed(false),
  }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
);
const serviceLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const input = {
  commandId: "interval-duration",
  title: "Interval review",
  prompt: "Review the open pull requests.",
  enabled: true,
  projectId: "project-interval-duration",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

it.effect.each([
  {
    zone: "America/New_York",
    from: "2026-03-08T06:30:00.000Z",
    everyMs: 7_200_000,
    expected: "2026-03-08T08:30:00.000Z",
  },
  {
    zone: "America/New_York",
    from: "2026-11-01T05:30:00.000Z",
    everyMs: 7_200_000,
    expected: "2026-11-01T07:30:00.000Z",
  },
  {
    zone: "America/New_York",
    from: "2026-11-01T06:30:00.000Z",
    everyMs: 60_000,
    expected: "2026-11-01T06:31:00.000Z",
  },
  {
    zone: "UTC",
    from: "2026-11-01T06:30:00.000Z",
    everyMs: 60_000,
    expected: "2026-11-01T06:31:00.000Z",
  },
  {
    zone: "Asia/Tokyo",
    from: "2026-03-08T06:30:00.000Z",
    everyMs: 7_200_000,
    expected: "2026-03-08T08:30:00.000Z",
  },
] as const)("persists elapsed interval $zone from $from", ({ zone, from, everyMs, expected }) =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", zone);
    yield* TestClock.setTime(Date.parse(from));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const decoded = yield* decodeInput({ ...input, schedule: { type: "interval", everyMs } });
      const created = yield* service.upsert(decoded);
      expect(created.task.nextRunAt).toBe(expected);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expected);

      const paused = yield* service.setEnabled({ id: created.task.id, enabled: false });
      expect(paused.task.nextRunAt).toBeNull();
      const resumed = yield* service.setEnabled({ id: created.task.id, enabled: true });
      expect(resumed.task.nextRunAt).toBe(expected);

      // Exercise completion rescheduling without starting any provider process.
      const completed = yield* service.runNow({ id: created.task.id });
      expect(completed.task.lastRunStatus).toBe("failed");
      expect(completed.threadId).toBeNull();
      expect(completed.task.runCount).toBe(1);
      expect(completed.task.nextRunAt).toBe(expected);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expected);
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    // Keep the real scheduler parked while exercising finite service actions.
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect.each([
  { from: "2026-03-07T23:30:00.000Z", expected: "2026-03-08T13:00:00.000Z" },
  { from: "2026-10-31T23:30:00.000Z", expected: "2026-11-01T14:00:00.000Z" },
] as const)("keeps fixed-time schedules on the local calendar from $from", ({ from, expected }) =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", "America/New_York");
    yield* TestClock.setTime(Date.parse(from));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const decoded = yield* decodeInput({
        ...input,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const created = yield* service.upsert(decoded);
      expect(created.task.nextRunAt).toBe(expected);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expected);
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("stops scheduled runs once a task reaches its run limit", () =>
  Effect.gen(function* () {
    const now = "2026-09-09T12:00:00.000Z";
    yield* TestClock.setTime(Date.parse(now));
    const sent = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: () => Ref.update(sent, (count) => count + 1).pipe(Effect.as({} as never)),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decodeInput({
          ...input,
          threadId: "thread-capped",
          maxRuns: 2,
          schedule: { type: "interval", everyMs: 60_000 },
        }),
      );
      expect(created.task.maxRuns).toBe(2);
      const first = yield* service.runNow({ id: created.task.id });
      expect(first.task).toMatchObject({ runCount: 1, enabled: true });
      expect(first.task.nextRunAt).not.toBeNull();
      const last = yield* service.runNow({ id: created.task.id });
      expect(last.task).toMatchObject({ runCount: 2, enabled: false, nextRunAt: null });
      expect(yield* Ref.get(sent)).toBe(2);

      // Even a row left enabled and due is never picked once it is out of runs.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE scheduled_tasks SET enabled = 1, next_run_at = ${now}`;
      yield* TestClock.adjust("1 minute");
      expect(yield* ScheduledTaskService.listDueTasks(yield* DateTime.now)).toEqual([]);

      // A save that omits the limit keeps it; raising it schedules the remaining runs.
      const kept = yield* service.upsert(
        yield* decodeInput({
          ...input,
          id: created.task.id,
          threadId: "thread-capped",
          schedule: { type: "interval", everyMs: 60_000 },
        }),
      );
      expect(kept.task.maxRuns).toBe(2);
      const raised = yield* service.upsert(
        yield* decodeInput({
          ...input,
          id: created.task.id,
          threadId: "thread-capped",
          maxRuns: 3,
          schedule: { type: "interval", everyMs: 60_000 },
        }),
      );
      expect(raised.task).toMatchObject({ runCount: 2, maxRuns: 3, enabled: true });
      expect(raised.task.nextRunAt).not.toBeNull();
      const cleared = yield* service.upsert(
        yield* decodeInput({
          ...input,
          id: created.task.id,
          threadId: "thread-capped",
          maxRuns: null,
          schedule: { type: "interval", everyMs: 60_000 },
        }),
      );
      expect(cleared.task.maxRuns).toBeUndefined();
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("compacts or moves to a fresh thread before a bound run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-09T12:00:00.000Z"));
    const sent = yield* Ref.make<ReadonlyArray<string>>([]);
    const launched = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (request) =>
              Ref.update(sent, (all) => [...all, `${request.threadId}:${request.text}`]).pipe(
                Effect.as({} as never),
              ),
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (request) =>
              Ref.updateAndGet(launched, (all) => [
                ...all,
                request.initialMessage?.text ?? "",
              ]).pipe(Effect.map((all) => ({ threadId: `fresh-${all.length}` }) as never)),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const compacting = yield* service.upsert(
        yield* decodeInput({
          ...input,
          commandId: "compacting",
          threadId: "chat",
          beforeRun: "compact",
          schedule: { type: "interval", everyMs: 60_000 },
        }),
      );
      expect(compacting.task.beforeRun).toBe("compact");
      yield* service.runNow({ id: compacting.task.id });
      expect(yield* Ref.get(sent)).toEqual(["chat:/compact", `chat:${input.prompt}`]);

      const fresh = yield* service.upsert(
        yield* decodeInput({
          ...input,
          commandId: "fresh",
          threadId: "chat",
          beforeRun: "new_thread",
          schedule: { type: "interval", everyMs: 60_000 },
        }),
      );
      const first = yield* service.runNow({ id: fresh.task.id });
      expect(first.task.threadId).toBe("fresh-1");
      const second = yield* service.runNow({ id: fresh.task.id });
      expect(second.task.threadId).toBe("fresh-2");
      expect(yield* Ref.get(launched)).toEqual([input.prompt, input.prompt]);
      expect(yield* Ref.get(sent)).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("a start time makes a one-off, and keeps a time of day from firing before it", () =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", "UTC");
    yield* TestClock.setTime(Date.parse("2026-09-09T12:00:00.000Z"));
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: () => Effect.succeed({} as never),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const once = yield* service.upsert(
        yield* decodeInput({
          ...input,
          commandId: "once",
          threadId: "thread-once",
          startAt: "2026-10-01T08:15:00.000Z",
          maxRuns: 1,
          schedule: { type: "interval", everyMs: 60_000 },
        }),
      );
      expect(once.task.nextRunAt).toBe("2026-10-01T08:15:00.000Z");
      const fired = yield* service.runNow({ id: once.task.id });
      expect(fired.task).toMatchObject({ runCount: 1, enabled: false, nextRunAt: null });

      // 2026-10-01 is a Thursday; the first Monday 09:00 after it is 2026-10-05.
      const weekly = yield* service.upsert(
        yield* decodeInput({
          ...input,
          commandId: "weekly",
          startAt: "2026-10-01T08:15:00.000Z",
          schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] },
        }),
      );
      expect(weekly.task.nextRunAt).toBe("2026-10-05T09:00:00.000Z");
      const unstarted = yield* service.upsert(
        yield* decodeInput({
          ...input,
          commandId: "weekly",
          id: weekly.task.id,
          startAt: null,
          schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] },
        }),
      );
      expect(unstarted.task.nextRunAt).toBe("2026-09-14T09:00:00.000Z");
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);
