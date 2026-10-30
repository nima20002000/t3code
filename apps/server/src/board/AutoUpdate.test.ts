import { assert, it } from "@effect/vitest";
import type { ForkReleaseEntry } from "@t3tools/board-core";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { AutoUpdateError, runAutoUpdate } from "./AutoUpdate.ts";

const fork = (version: string): ForkReleaseEntry => ({ tag_name: `v${version}` });

/** A server on `currentVersion` whose release list, busy state and updates the test controls. */
const server = Effect.fn(function* (
  currentVersion: string,
  initial: {
    readonly releases: ReadonlyArray<ForkReleaseEntry>;
    readonly busy?: string | null;
    readonly failUpdates?: boolean;
  },
) {
  const releases = yield* Ref.make(initial.releases);
  const busy = yield* Ref.make(initial.busy ?? null);
  const updates = yield* Ref.make<ReadonlyArray<string>>([]);
  const fiber = yield* runAutoUpdate({
    currentVersion,
    releases: Ref.get(releases),
    busy: Ref.get(busy),
    update: (targetVersion) =>
      Ref.update(updates, (all) => [...all, targetVersion]).pipe(
        Effect.andThen(
          initial.failUpdates === true
            ? Effect.fail(new AutoUpdateError({ step: "update" }))
            : Effect.void,
        ),
      ),
  }).pipe(Effect.forkChild);
  return { releases, busy, updates: Ref.get(updates), fiber };
});

it.effect("updates to the newest fork release shortly after start when idle", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.3", {
      releases: [fork("0.1.5-board.5"), fork("0.1.5-board.4"), fork("0.1.5-board.3")],
    });
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* s.updates, []);
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.5"]);
    // Handed off: the service restarts on the new version, so this server stops checking.
    yield* Fiber.join(s.fiber);
  }),
);

it.effect("ignores a newer upstream t3 release and keeps checking hourly", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.4", {
      releases: [{ tag_name: "v0.1.9" }, fork("0.1.5-board.4")],
    });
    yield* TestClock.adjust("3 hours");
    assert.deepStrictEqual(yield* s.updates, []);
    yield* Ref.set(s.releases, [{ tag_name: "v0.1.9" }, fork("0.1.6-board.1")]);
    yield* TestClock.adjust("1 hour");
    assert.deepStrictEqual(yield* s.updates, ["0.1.6-board.1"]);
  }),
);

it.effect("never downgrades and never moves a build that is not a fork build", () =>
  Effect.gen(function* () {
    const newer = yield* server("0.1.6-board.2", { releases: [fork("0.1.6-board.1")] });
    const upstreamBuild = yield* server("0.1.5", { releases: [fork("0.1.6-board.1")] });
    yield* TestClock.adjust("5 hours");
    assert.deepStrictEqual(yield* newer.updates, []);
    assert.deepStrictEqual(yield* upstreamBuild.updates, []);
  }),
);

it.effect("waits while a turn runs and updates once the server is idle", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.3", {
      releases: [fork("0.1.5-board.4")],
      busy: "an agent turn is running",
    });
    yield* TestClock.adjust("90 minutes");
    assert.deepStrictEqual(yield* s.updates, []);
    yield* Ref.set(s.busy, "a board run is running");
    yield* TestClock.adjust("10 minutes");
    assert.deepStrictEqual(yield* s.updates, []);
    yield* Ref.set(s.busy, null);
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.4"]);
  }),
);

it.effect("a failed update is tried again at the next hourly check", () =>
  Effect.gen(function* () {
    const s = yield* server("0.1.5-board.3", {
      releases: [fork("0.1.5-board.4")],
      failUpdates: true,
    });
    yield* TestClock.adjust("2 minutes");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.4"]);
    yield* TestClock.adjust("59 minutes");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.4"]);
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* s.updates, ["0.1.5-board.4", "0.1.5-board.4"]);
  }),
);
