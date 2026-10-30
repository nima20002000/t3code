import { forkUpdateTarget, type ForkReleaseEntry } from "@t3tools/board-core";
import { ServerSelfUpdateError, type ServerSelfUpdateOutcome } from "@t3tools/contracts";
import { cliReleaseIndexPageUrl } from "@t3tools/shared/cliRelease";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as BoardStore from "./BoardStore.ts";
import {
  forkParked,
  ProjectionStore,
  ServerConfig,
  serverVersion,
  ServerSelfUpdate,
  ServiceLauncherClient,
  ServerLifecycleEvents,
} from "./upstream.ts";

const FIRST_CHECK_DELAY = Duration.minutes(2);
const CHECK_INTERVAL = Duration.hours(1);
const IDLE_RECHECK = Duration.minutes(1);
const MAX_RELEASE_PAGES = 10;

/** A step of an auto-update that failed; the next hourly check tries again. `handoff` means work
 * started while the release was being staged, so the update waits for idle again instead. */
export class AutoUpdateError extends Schema.TaggedError<AutoUpdateError>()("AutoUpdateError", {
  step: Schema.Literals(["releases", "busy", "update", "handoff"]),
  cause: Schema.optional(Schema.Defect()),
}) {}

const isAutoUpdateError = Schema.is(AutoUpdateError);

const failedAt =
  (step: AutoUpdateError["step"]) =>
  (cause: unknown): AutoUpdateError =>
    new AutoUpdateError({ step, cause });

export interface AutoUpdateDeps {
  readonly currentVersion: string;
  readonly previousUpdate?: Effect.Effect<ServerSelfUpdateOutcome | undefined>;
  readonly releases: Effect.Effect<ReadonlyArray<ForkReleaseEntry>, AutoUpdateError>;
  /** Why this server is busy now, or null when nothing runs that an update would cut. */
  readonly busy: Effect.Effect<string | null, AutoUpdateError>;
  /** Hands the update to t3's own self-update; the service restarts on the new version.
   * `beforeHandoff` runs once the release is staged, right before the restart, and fails when
   * work started meanwhile, which must abort the update. */
  readonly update: (
    targetVersion: string,
    beforeHandoff: Effect.Effect<void, AutoUpdateError>,
  ) => Effect.Effect<void, AutoUpdateError>;
}

const updateTarget = Effect.fn("BoardAutoUpdate.target")(function* (deps: AutoUpdateDeps) {
  const releases = yield* deps.releases.pipe(Effect.option);
  if (Option.isNone(releases)) {
    yield* Effect.logWarning("Board auto-update could not list the fork's releases");
    return undefined;
  }
  const target = forkUpdateTarget(deps.currentVersion, releases.value);
  const previous = yield* deps.previousUpdate ?? Effect.undefined;
  if (
    previous !== undefined &&
    (previous.status === "rolled-back" || previous.status === "failed") &&
    previous.targetVersion === target
  ) {
    yield* Effect.logWarning("Board auto-update skips a release the service already rejected", {
      targetVersion: target,
    });
    return undefined;
  }
  return target;
});

const busyNow = (deps: AutoUpdateDeps) =>
  deps.busy.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Board auto-update could not tell whether this server is busy", {
        cause,
      }).pipe(Effect.as("busy state unknown")),
    ),
  );

/** Waits until nothing runs, then updates. True once the update was handed off. */
const updateWhenIdle = Effect.fn("BoardAutoUpdate.updateWhenIdle")(function* (
  deps: AutoUpdateDeps,
  initialTarget: string,
) {
  let targetVersion = initialTarget;
  while (true) {
    let waitingFor: string | null = null;
    while (true) {
      const reason = yield* busyNow(deps);
      if (reason === null) break;
      if (reason !== waitingFor) {
        yield* Effect.logInfo("Board auto-update waits until this server is idle", {
          targetVersion,
          reason,
        });
        waitingFor = reason;
      }
      yield* Effect.sleep(IDLE_RECHECK);
    }
    if (waitingFor !== null) {
      const refreshed = yield* updateTarget(deps);
      if (refreshed === undefined) return false;
      targetVersion = refreshed;
    }
    yield* Effect.logInfo("Board auto-update is updating this server", {
      from: deps.currentVersion,
      to: targetVersion,
    });
    const beforeHandoff = busyNow(deps).pipe(
      Effect.flatMap((reason) =>
        reason === null ? Effect.void : Effect.fail(new AutoUpdateError({ step: "handoff" })),
      ),
    );
    const outcome = yield* deps.update(targetVersion, beforeHandoff).pipe(
      Effect.as("handed-off" as const),
      Effect.catch((error) =>
        error.step === "handoff"
          ? Effect.logInfo(
              "Board auto-update held the restart: work started while the release was staged",
              { targetVersion },
            ).pipe(Effect.as("work-started" as const))
          : Effect.logWarning("Board auto-update failed; it tries again at the next check", {
              targetVersion,
              cause: error,
            }).pipe(Effect.as("failed" as const)),
      ),
    );
    if (outcome !== "work-started") return outcome === "handed-off";
  }
});

const checkOnce = Effect.fn("BoardAutoUpdate.check")(function* (deps: AutoUpdateDeps) {
  const target = yield* updateTarget(deps);
  if (target === undefined) {
    yield* Effect.logInfo("Board auto-update: no newer fork release", {
      currentVersion: deps.currentVersion,
    });
    return false;
  }
  return yield* updateWhenIdle(deps, target);
});

/** Checks shortly after start, then hourly, until an update is handed off. */
export const runAutoUpdate = Effect.fn("BoardAutoUpdate.run")(function* (deps: AutoUpdateDeps) {
  yield* Effect.sleep(FIRST_CHECK_DELAY);
  while (!(yield* checkOnce(deps))) {
    yield* Effect.sleep(CHECK_INTERVAL);
  }
});

const LIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/**
 * What a restart would cut on this server, or null. Reads the same runtime state t3's own restart
 * recovery reads, so it also sees T3 Code's silent idle compactions (hidden from the thread shell),
 * queued turns and pending background work, not only the turns a thread list shows.
 */
export const serverBusyReason = Effect.fn("BoardAutoUpdate.serverBusyReason")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* BoardStore.BoardStore;
  for (const threadId of yield* projections.getRecoveryThreadIds("runtime")) {
    const thread = yield* projections.getRuntimeRecoveryProjection(threadId);
    if (
      thread.runs.some(
        (run) =>
          LIVE_RUN_STATUSES.has(run.status) || (run.status === "queued" && run.queueHeld !== true),
      )
    )
      return "an agent turn is running";
    if (
      thread.providerThreads.some((provider) => (provider.pendingBackgroundTasks?.length ?? 0) > 0)
    )
      return "an agent's background work is pending";
  }
  const workflows = yield* store.listWorkflows();
  if (
    workflows.some((workflow) =>
      workflow.runs.some((run) => run.status === "running" || run.status === "stopping"),
    )
  )
    return "a board run is running";
  return null;
});

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
    prerelease: Schema.optional(Schema.Boolean),
  }),
);

export const listForkReleases = Effect.fn("BoardAutoUpdate.listReleases")(function* (
  indexUrl: string,
  githubToken: Option.Option<string>,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const releases: ForkReleaseEntry[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const url = new URL(indexUrl);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const request = HttpClientRequest.get(url.toString()).pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
      (base) =>
        Option.match(githubToken, {
          onNone: () => base,
          onSome: (token) => HttpClientRequest.setHeader(base, "Authorization", `Bearer ${token}`),
        }),
    );
    const entries = yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(ReleaseIndex)),
      Effect.timeout(Duration.seconds(30)),
      Effect.mapError(failedAt("releases")),
    );
    releases.push(...entries);
    if (entries.length < 100) break;
  }
  return releases;
});

/**
 * Service-managed headless servers follow the fork's releases on their own. Desktop-hosted
 * servers update with their app, and servers started by hand have nothing to restart them.
 * `T3_BOARD_AUTO_UPDATE=0` turns it off; `T3_BOARD_RELEASE_INDEX_URL` replaces the release list.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const enabled = yield* Config.String("T3_BOARD_AUTO_UPDATE").pipe(Config.withDefault("1"));
    if (enabled.trim() === "0") {
      yield* Effect.logInfo("Board auto-update is off (T3_BOARD_AUTO_UPDATE=0)");
      return;
    }
    const config = yield* ServerConfig.ServerConfig;
    const launcher = yield* Effect.serviceOption(ServiceLauncherClient.ServiceLauncherClient);
    const selfUpdate = yield* Effect.serviceOption(ServerSelfUpdate.ServerSelfUpdate);
    if (
      config.mode === "desktop" ||
      Option.isNone(selfUpdate) ||
      !Option.exists(launcher, (client) => client.managed)
    ) {
      yield* Effect.logDebug("Board auto-update skipped: not a service-managed headless server");
      return;
    }
    const indexUrl = yield* Config.String("T3_BOARD_RELEASE_INDEX_URL").pipe(
      Config.withDefault(cliReleaseIndexPageUrl(1)),
    );
    const githubToken = yield* Config.String("GH_TOKEN").pipe(
      Config.orElse(() => Config.String("GITHUB_TOKEN")),
      Config.option,
    );
    const httpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
    const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
    if (Option.isNone(httpClient) || Option.isNone(projections)) return;
    const store = yield* BoardStore.BoardStore;
    const lifecycle = yield* Effect.serviceOption(ServerLifecycleEvents.ServerLifecycleEvents);
    const previousUpdate = Option.match(lifecycle, {
      onNone: () => Effect.undefined,
      onSome: (events) =>
        events.snapshot.pipe(
          Effect.map(
            (snapshot) =>
              snapshot.events.find((event) => event.type === "ready")?.payload.updateOutcome,
          ),
        ),
    });

    const releases = listForkReleases(indexUrl, githubToken).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient.value),
    );
    const busy = serverBusyReason().pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, projections.value),
      Effect.provideService(BoardStore.BoardStore, store),
      Effect.mapError(failedAt("busy")),
    );

    yield* Effect.logInfo("Board auto-update follows the fork's releases", {
      currentVersion: serverVersion,
      releaseIndex: indexUrl,
    });
    yield* forkParked(
      runAutoUpdate({
        currentVersion: serverVersion,
        previousUpdate,
        releases,
        busy,
        update: (targetVersion, beforeHandoff) =>
          selfUpdate.value
            .update({ targetVersion }, (stage) =>
              // "installing" comes right before the launcher handoff; staging is done by then.
              stage === "installing"
                ? beforeHandoff.pipe(
                    Effect.mapError(
                      (cause) =>
                        new ServerSelfUpdateError({
                          reason: "Work started while the update was staged.",
                          cause,
                        }),
                    ),
                  )
                : Effect.void,
            )
            .pipe(
              Effect.asVoid,
              Effect.mapError((error) =>
                isAutoUpdateError(error.cause) ? error.cause : failedAt("update")(error),
              ),
            ),
      }),
    );
  }),
);
