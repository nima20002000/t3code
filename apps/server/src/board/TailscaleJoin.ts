import { BoardInvalidRequestError, type BoardTailscaleStatus } from "@t3tools/board-core";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const INSTALL_SCRIPT_URL = "https://tailscale.com/install.sh";
const AUTH_KEY = /^tskey-[A-Za-z0-9-]+$/;

// Exit codes the join script uses for install failures, so they are not mistaken for pkexec's own.
const DOWNLOAD_FAILED = 90;
const INSTALLER_FAILED = 91;
const NOT_INSTALLED = 92;

/** One administrator prompt installs Tailscale when it is missing, then joins with the key file. */
export function tailscaleJoinCommand(input: {
  readonly keyFile: string;
  readonly operator: string;
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const script = [
    "set -e",
    "if ! command -v tailscale >/dev/null 2>&1; then",
    "  installer=$(mktemp)",
    `  curl -fsSL ${INSTALL_SCRIPT_URL} -o "$installer" || exit ${DOWNLOAD_FAILED}`,
    `  sh "$installer" || exit ${INSTALLER_FAILED}`,
    '  rm -f "$installer"',
    `  command -v tailscale >/dev/null 2>&1 || exit ${NOT_INSTALLED}`,
    "fi",
    'tailscale up --auth-key="file:$1" --operator="$2" --reset --force-reauth',
  ].join("\n");
  return {
    command: "pkexec",
    args: ["/bin/sh", "-c", script, "t3-board-tailscale", input.keyFile, input.operator],
  };
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (all, chunk) => all + chunk,
    ),
  );

/** `missing` when the program cannot start at all (not installed). */
const run = Effect.fn("TailscaleJoin.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  timeout: `${number} minutes` | `${number} seconds`,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make(command, [...args]));
    const [stdout, stderr, code] = yield* Effect.all(
      [text(child.stdout), text(child.stderr), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    );
    return { code: code as number | "missing" | "timeout", stdout, stderr };
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => ({ code: "missing" as const, stdout: "", stderr: "" })),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.succeed({ code: "timeout" as const, stdout: "", stderr: "" }),
    }),
    // A broken PATH entry makes spawn throw synchronously, which surfaces as a defect.
    Effect.catchDefect(() => Effect.succeed({ code: "missing" as const, stdout: "", stderr: "" })),
  );
});

const StatusJson = Schema.fromJsonString(
  Schema.Struct({
    BackendState: Schema.optional(Schema.String),
    CurrentTailnet: Schema.optional(Schema.NullOr(Schema.Struct({ Name: Schema.String }))),
    Self: Schema.optional(
      Schema.NullOr(Schema.Struct({ TailscaleIPs: Schema.optional(Schema.Array(Schema.String)) })),
    ),
  }),
);
const decodeStatus = Schema.decodeUnknownOption(StatusJson);

/** Only a running Tailscale counts: a stopped one still reports the address it last had. */
export function readTailscaleStatus(result: {
  readonly code: number | string;
  readonly stdout: string;
}): BoardTailscaleStatus {
  const parsed = Option.getOrUndefined(decodeStatus(result.stdout));
  const running = parsed?.BackendState === "Running";
  return {
    installed: result.code !== "missing",
    ipv4: running ? (parsed?.Self?.TailscaleIPs?.find((ip) => !ip.includes(":")) ?? null) : null,
    tailnet: running ? (parsed?.CurrentTailnet?.Name ?? null) : null,
  };
}

export const status = Effect.fn("TailscaleJoin.status")(function* () {
  return readTailscaleStatus(yield* run("tailscale", ["status", "--json"], "10 seconds"));
});

export const join = Effect.fn("TailscaleJoin.join")(function* (authKey: string) {
  const key = authKey.trim();
  if ((yield* HostProcess.Platform) !== "linux")
    return yield* new BoardInvalidRequestError({
      message: "Joining Tailscale from the app works on Linux only for now.",
    });
  if (!AUTH_KEY.test(key))
    return yield* new BoardInvalidRequestError({
      message: "That is not a Tailscale join key. It starts with tskey-.",
    });
  const operator = yield* HostProcess.Username;
  if (!operator)
    return yield* new BoardInvalidRequestError({
      message: "Could not tell which user runs this app.",
    });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The key goes to a private file, never into a command line other users can read.
  const result = yield* Effect.gen(function* () {
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-board-tailscale-" });
    const keyFile = path.join(dir, "key");
    yield* fs.writeFileString(keyFile, key, { mode: 0o600 });
    const command = tailscaleJoinCommand({ keyFile, operator });
    return yield* run(command.command, command.args, "10 minutes");
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      () => new BoardInvalidRequestError({ message: "Could not prepare the Tailscale join." }),
    ),
  );
  if (result.code === "missing")
    return yield* new BoardInvalidRequestError({
      message:
        "This computer cannot ask for administrator permission (pkexec is missing). Install Tailscale from tailscale.com/download and run: sudo tailscale up --auth-key=<your key>",
    });
  if (result.code === "timeout")
    return yield* new BoardInvalidRequestError({
      message: "Joining Tailscale took too long. Check the internet connection and try again.",
    });
  // pkexec exits 126 when the person closes or cancels the password prompt, 127 when refused.
  if (result.code === 126 || result.code === 127)
    return yield* new BoardInvalidRequestError({
      message: "Administrator permission was not given, so Tailscale was not set up.",
    });
  if (result.code === DOWNLOAD_FAILED)
    return yield* new BoardInvalidRequestError({
      message: "Could not download Tailscale. Check the internet connection and try again.",
    });
  if (result.code === INSTALLER_FAILED || result.code === NOT_INSTALLED)
    return yield* new BoardInvalidRequestError({
      message:
        "Tailscale could not be installed. Install it from tailscale.com/download, then try again.",
    });
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").slice(-2).join(" ");
    return yield* new BoardInvalidRequestError({
      message: `Tailscale could not join${detail ? `: ${detail}` : "."}`,
    });
  }
  return yield* status();
});
