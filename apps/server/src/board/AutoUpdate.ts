import { forkUpdateTarget, type ForkReleaseEntry } from "@t3tools/board-core";
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
  ServerConfig,
  serverVersion,
  ServerSelfUpdate,
  ServiceLauncherClient,
  ThreadManagement,
} from "./upstream.ts";

const FIRST_CHECK_DELAY = Duration.minutes(2);
const CHECK_INTERVAL = Duration.hours(1);
const IDLE_RECHECK = Duration.minutes(1);

/** A step of an auto-update that failed; the next hourly check tries again. */
export class AutoUpdateError extends Schema.TaggedError<AutoUpdateError>()("AutoUpdateError", {
  step: Schema.Literals(["releases", "busy", "update"]),
  cause: Schema.optional(Schema.Defect()),
}) {}

const failedAt =
  (step: AutoUpdateError["step"]) =>
  (cause: unknown): AutoUpdateError =>
    new AutoUpdateError({ step, cause });

export interface AutoUpdateDeps {
  readonly currentVersion: string;
  readonly releases: Effect.Effect<ReadonlyArray<ForkReleaseEntry>, AutoUpdateError>;
  /** Why this server is busy now, or null when nothing runs that an update would cut. */
  readonly busy: Effect.Effect<string | null, AutoUpdateError>;
  /** Hands the update to t3's own self-update; the service restarts on the new version. */
  readonly update: (targetVersion: string) => Effect.Effect<void, AutoUpdateError>;
}

/** Waits until nothing runs, then updates. True once the update was handed off. */
const updateWhenIdle = Effect.fn("BoardAutoUpdate.updateWhenIdle")(function* (
  deps: AutoUpdateDeps,
  targetVersion: string,
) {
  let waitingFor: string | null = null;
  while (true) {
    const reason = yield* deps.busy.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Board auto-update could not tell whether this server is busy", {
          cause,
        }).pipe(Effect.as("busy state unknown")),
      ),
    );
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
  yield* Effect.logInfo("Board auto-update is updating this server", {
    from: deps.currentVersion,
    to: targetVersion,
  });
  return yield* deps.update(targetVersion).pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      Effect.logWarning("Board auto-update failed; it tries again at the next check", {
        targetVersion,
        cause,
      }).pipe(Effect.as(false)),
    ),
  );
});

const checkOnce = Effect.fn("BoardAutoUpdate.check")(function* (deps: AutoUpdateDeps) {
  const releases = yield* deps.releases.pipe(Effect.option);
  if (Option.isNone(releases)) {
    yield* Effect.logWarning("Board auto-update could not list the fork's releases");
    return false;
  }
  const target = forkUpdateTarget(deps.currentVersion, releases.value);
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

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
    prerelease: Schema.optional(Schema.Boolean),
  }),
);

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
    if (Option.isNone(httpClient)) return;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* BoardStore.BoardStore;

    const request = HttpClientRequest.get(indexUrl).pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
      (base) =>
        Option.match(githubToken, {
          onNone: () => base,
          onSome: (token) => HttpClientRequest.setHeader(base, "Authorization", `Bearer ${token}`),
        }),
    );
    const releases = httpClient.value.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(ReleaseIndex)),
      Effect.timeout(Duration.seconds(30)),
      Effect.mapError(failedAt("releases")),
    );
    const busy = Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot();
      if (snapshot.threads.some((thread) => thread.activeRunId !== null))
        return "an agent turn is running";
      const workflows = yield* store.listWorkflows();
      if (
        workflows.some((workflow) =>
          workflow.runs.some((run) => run.status === "running" || run.status === "stopping"),
        )
      )
        return "a board run is running";
      return null;
    }).pipe(Effect.mapError(failedAt("busy")));

    yield* Effect.logInfo("Board auto-update follows the fork's releases", {
      currentVersion: serverVersion,
      releaseIndex: indexUrl,
    });
    yield* forkParked(
      runAutoUpdate({
        currentVersion: serverVersion,
        releases,
        busy,
        update: (targetVersion) =>
          selfUpdate.value
            .update({ targetVersion })
            .pipe(Effect.asVoid, Effect.mapError(failedAt("update"))),
      }),
    );
  }),
);
