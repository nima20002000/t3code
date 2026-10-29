import type { PreviewSetupHostResult, ServerBrowserMode } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const SETUP_SUBCOMMAND = "browser setup";

/** The setup command for a mode; headless keeps the plain command older hosts print. */
export const setupSubcommand = (mode: ServerBrowserMode) =>
  mode === "headed" ? `${SETUP_SUBCOMMAND} --mode headed` : SETUP_SUBCOMMAND;

export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

export const sandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  env.T3CODE_SERVER_BROWSER_SANDBOX === "0";

/** Set on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/t3-chrome-headless-shell";
const APPARMOR_PROFILE_NAME = "t3-chrome-headless-shell";
const LOADED_PROFILES = "/sys/kernel/security/apparmor/profiles";

/** Match Ubuntu's Chrome profile; unconfined adds nothing beyond userns. */
export const APPARMOR_PROFILE = `# Written by \`t3 browser setup\`: lets T3 Code's headless browser use Chrome's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile t3-chrome-headless-shell /**/tools/chrome-headless-shell/*/*/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/t3-chrome-headless-shell>
}
`;

/** Ubuntu 24.04 and Debian 13 use some t64 library names; choose names available through apt. */
export const DEBIAN_PACKAGES: ReadonlyArray<ReadonlyArray<string>> = [
  ["libnss3"],
  ["libglib2.0-0t64", "libglib2.0-0"],
  ["libatk1.0-0t64", "libatk1.0-0"],
  ["libatk-bridge2.0-0t64", "libatk-bridge2.0-0"],
  ["libatspi2.0-0t64", "libatspi2.0-0"],
  ["libdbus-1-3"],
  ["libx11-6"],
  ["libxcb1"],
  ["libxcomposite1"],
  ["libxdamage1"],
  ["libxext6"],
  ["libxfixes3"],
  ["libxrandr2"],
  ["libxkbcommon0"],
  ["libgbm1"],
  ["libasound2t64", "libasound2"],
  ["libexpat1"],
];

export class PreviewBrowserSandboxError extends Schema.TaggedError<PreviewBrowserSandboxError>()(
  "PreviewBrowserSandboxError",
  { setupCommand: Schema.String },
) {
  override get message(): string {
    return `This host blocks the sandbox T3's browser runs in (AppArmor on Ubuntu 23.10+). Run \`${this.setupCommand}\` on the host once to allow it, then try again.`;
  }
}

export class PreviewBrowserLibrariesError extends Schema.TaggedError<PreviewBrowserLibrariesError>()(
  "PreviewBrowserLibrariesError",
  { setupCommand: Schema.String, libraries: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `This host is missing libraries T3's browser needs (${this.libraries.join(", ")}). Run \`${this.setupCommand}\` on the host to install them, then try again.`;
  }
}

/** Chrome will not start its sandbox as root (crbug.com/638180), which no host setup fixes. */
export class PreviewBrowserRootError extends Schema.TaggedError<PreviewBrowserRootError>()(
  "PreviewBrowserRootError",
  {},
) {
  override get message(): string {
    return "Chrome will not start its sandbox as root, so T3's browser cannot run while the T3 server runs as root. Run the server as a nonroot user (for example `User=` in its systemd service), or set `T3CODE_SERVER_BROWSER_SANDBOX=0` to run the browser unsandboxed as root.";
  }
}

export class PreviewBrowserHeadedError extends Schema.TaggedError<PreviewBrowserHeadedError>()(
  "PreviewBrowserHeadedError",
  { setupCommand: Schema.String, missing: Schema.Literals(["browser", "display"]) },
) {
  override get message(): string {
    return this.missing === "browser"
      ? `This host is set to show its browser but has no Google Chrome. Run \`${this.setupCommand}\` on the host to install it, then try again.`
      : `This host is set to show its browser but has no display to show it on. Run \`${this.setupCommand}\` on the host to install Xvfb, or set DISPLAY for the T3 server, then try again.`;
  }
}

export type PreviewBrowserHostError =
  | PreviewBrowserSandboxError
  | PreviewBrowserLibrariesError
  | PreviewBrowserRootError
  | PreviewBrowserHeadedError;

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;
const LOADER_ERROR = /error while loading shared libraries: ([^:\s]+)/;

export const diagnoseLaunchFailure = Effect.fn("PreviewBrowserHost.diagnoseLaunchFailure")(
  function* (input: {
    readonly executable: string;
    readonly output: string;
    readonly setupCommand: string;
  }) {
    const { setupCommand } = input;
    if (input.output.includes(NO_SANDBOX_SIGNATURE)) {
      // Playwright reports Chrome's refusal to sandbox as root as a sandbox failure too.
      return (yield* HostProcess.UserId) === 0
        ? new PreviewBrowserRootError()
        : new PreviewBrowserSandboxError({ setupCommand });
    }
    if ((yield* HostProcess.Platform) !== "linux") return undefined;
    const libraries = yield* missingLibraries(input.executable);
    return libraries.length === 0
      ? undefined
      : new PreviewBrowserLibrariesError({ setupCommand, libraries });
  },
);

/** Detect missing libraries with --version; ldd can report misses that NixOS nix-ld provides. */
export const missingLibraries = Effect.fn("PreviewBrowserHost.missingLibraries")(function* (
  executable: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = (command: string, args: ReadonlyArray<string>) =>
    spawner
      .string(ChildProcess.make(command, args, { stdin: "ignore" }), { includeStderr: true })
      .pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => ""),
      );
  const loaderError = LOADER_ERROR.exec(yield* run(executable, ["--version"]))?.[1];
  if (loaderError === undefined) return [];
  const listed = [...(yield* run("ldd", [executable])).matchAll(MISSING_LIBRARY)].map(
    (match) => match[1]!,
  );
  return listed.length > 0 ? listed : [loaderError];
});

export const sandboxBlocked = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return false;
  const fs = yield* FileSystem.FileSystem;
  const restricted = yield* fs.readFileString(USERNS_RESTRICTION).pipe(
    Effect.map((value) => value.trim() === "1"),
    Effect.orElseSucceed(() => false),
  );
  if (!restricted) return false;
  // A profile written but never loaded (its load failed) still blocks; root can see what is loaded.
  const loaded = yield* fs.readFileString(LOADED_PROFILES).pipe(
    Effect.map((profiles) =>
      profiles.split("\n").some((line) => line.startsWith(`${APPARMOR_PROFILE_NAME} `)),
    ),
    Effect.option,
  );
  if (loaded._tag === "Some") return !loaded.value;
  return !(yield* fs.exists(APPARMOR_PROFILE_PATH).pipe(Effect.orElseSucceed(() => false)));
}).pipe(Effect.withSpan("PreviewBrowserHost.sandboxBlocked"));

/**
 * Chrome starts without fonts, but pages then render no text. Without
 * fontconfig there is no `fc-match` at all, which counts as no font.
 */
export const fontAvailable = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return true;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const font = yield* spawner
    .string(
      ChildProcess.make("fc-match", ["--format=%{file}", "sans-serif"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ""),
    );
  return font.trim() !== "";
}).pipe(Effect.withSpan("PreviewBrowserHost.fontAvailable"));

const HEADED_BROWSER_PATHS: Partial<Record<NodeJS.Platform, ReadonlyArray<string>>> = {
  linux: ["/opt/google/chrome/chrome"],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
};
const HEADED_BROWSER_COMMANDS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
];

/** The real Chrome headed mode runs: Google Chrome where installed, else a Chromium on PATH. */
export const headedBrowser = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const path of HEADED_BROWSER_PATHS[yield* HostProcess.Platform] ?? []) {
    if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) return Option.some(path);
  }
  for (const command of HEADED_BROWSER_COMMANDS) {
    const path = yield* resolveCommandPath(command);
    if (path !== null) return Option.some(path);
  }
  return Option.none<string>();
}).pipe(Effect.withSpan("PreviewBrowserHost.headedBrowser"));

export type HeadedDisplay =
  | { readonly _tag: "display"; readonly display: string }
  | { readonly _tag: "xvfb" }
  | { readonly _tag: "none" };

const X_SOCKETS = "/tmp/.X11-unix";

/**
 * Where a headed browser shows on Linux: the server's DISPLAY, else an X display this user runs
 * (such as a VNC server's), else an Xvfb the server starts. Other systems show on their desktop.
 */
export const headedDisplay = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return { _tag: "display", display: "" } as const;
  const display = (yield* HostProcess.Environment).DISPLAY?.trim();
  if (display) return { _tag: "display", display } as const;
  const fs = yield* FileSystem.FileSystem;
  const uid = yield* HostProcess.UserId;
  const owned: Array<number> = [];
  for (const entry of yield* fs.readDirectory(X_SOCKETS).pipe(Effect.orElseSucceed(() => []))) {
    const number = /^X(\d+)$/.exec(entry)?.[1];
    if (number === undefined) continue;
    const info = yield* fs.stat(`${X_SOCKETS}/${entry}`).pipe(Effect.option);
    if (Option.isSome(info) && Option.getOrUndefined(info.value.uid) === uid) {
      owned.push(Number(number));
    }
  }
  if (owned.length > 0) return { _tag: "display", display: `:${Math.min(...owned)}` } as const;
  return (yield* resolveCommandPath("Xvfb")) === null
    ? ({ _tag: "none" } as const)
    : ({ _tag: "xvfb" } as const);
}).pipe(Effect.withSpan("PreviewBrowserHost.headedDisplay"));

/** What headed mode still lacks on this host; empty when it is ready. */
export const headedNeeds = Effect.gen(function* () {
  const needs: Array<"browser" | "display" | "fonts"> = [];
  if (Option.isNone(yield* headedBrowser)) needs.push("browser");
  if ((yield* headedDisplay)._tag === "none") needs.push("display");
  if (!(yield* fontAvailable)) needs.push("fonts");
  return needs;
}).pipe(Effect.withSpan("PreviewBrowserHost.headedNeeds"));

/** What headless mode still lacks on this host; the shell is checked only once it is installed. */
export const headlessNeeds = Effect.fn("PreviewBrowserHost.headlessNeeds")(function* (
  executable: Option.Option<string>,
) {
  const needs: Array<"sandbox" | "libraries" | "fonts"> = [];
  if (!sandboxDisabled(yield* HostProcess.Environment) && (yield* sandboxBlocked)) {
    needs.push("sandbox");
  }
  if (Option.isSome(executable) && (yield* missingLibraries(executable.value)).length > 0) {
    needs.push("libraries");
  }
  if (!(yield* fontAvailable)) needs.push("fonts");
  return needs;
});

const SUDO_REFUSED =
  /password is required|terminal is required|no tty present|not in the sudoers|may not run sudo/i;
const OUTPUT_TAIL = 1500;
const SETUP_TIMEOUT = "15 minutes";

/**
 * Runs this host's own browser setup as root without prompting (`sudo -n`), so a client can set
 * up the machine its browser runs on. Without passwordless sudo it hands back the manual command.
 */
export const runHostSetup = Effect.fn("PreviewBrowserHost.runHostSetup")(function* <R>(input: {
  readonly needsSetup: Effect.Effect<boolean, never, R>;
  /** The server's own CLI and its arguments, such as `[t3, "browser", "setup"]`. */
  readonly argv: ReadonlyArray<string>;
  /** What a person runs by hand when this cannot. */
  readonly command: string;
}) {
  const ready = (ranSetup: boolean): PreviewSetupHostResult => ({ _tag: "Ready", ranSetup });
  const failed = (detail: string): PreviewSetupHostResult => ({
    _tag: "Failed",
    command: input.command,
    detail: detail.trim().slice(-OUTPUT_TAIL),
  });
  if (!(yield* input.needsSetup)) return ready(false);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("sudo", ["-n", ...input.argv], { stdin: "ignore" }),
      );
      const [output, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
        { concurrency: 2 },
      );
      return { output, exitCode: Number(exitCode) };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: SETUP_TIMEOUT,
      orElse: () => Effect.succeed({ output: "Setup timed out.", exitCode: -1 }),
    }),
    Effect.catch((cause) => Effect.succeed({ output: String(cause), exitCode: -1 })),
  );
  const { output, exitCode } = yield* run;
  if (exitCode !== 0) {
    return SUDO_REFUSED.test(output)
      ? ({ _tag: "NeedsPassword", command: input.command } satisfies PreviewSetupHostResult)
      : failed(output || `Setup exited with ${exitCode}.`);
  }
  // Setup can finish without fixing everything, such as on a host without apt.
  return (yield* input.needsSetup)
    ? failed(output || "Setup finished, but the host still needs setup.")
    : ready(true);
});
