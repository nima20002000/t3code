import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";

// What `ldd` printed for the pinned headless shell in a bare debian:trixie-slim container.
const LDD_IN_BARE_DEBIAN = `\tlinux-vdso.so.1 (0x00007ffd2d1f8000)
\tlibdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007f0c1b6a1000)
\tlibglib-2.0.so.0 => not found
\tlibnss3.so => not found
\tlibX11.so.6 => not found
\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0c1b4c0000)
`;

// Chrome's own abort on Ubuntu 26.04 with unprivileged user namespaces restricted.

const LOADER_ERROR =
  "chrome-headless-shell: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file: No such file or directory";

const hostReporting = (output: { readonly version: string; readonly ldd: string }) => {
  const commands: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { command: name, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push([name, ...args].join(" "));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.make(new TextEncoder().encode(name === "ldd" ? output.ldd : output.version)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, commands };
};

const diagnose = (input: {
  platform: NodeJS.Platform;
  output: string;
  ldd: string;
  version?: string;
  uid?: number;
}) => {
  const { spawner, commands } = hostReporting({
    ldd: input.ldd,
    version: input.version ?? LOADER_ERROR,
  });
  return PreviewBrowserHost.diagnoseLaunchFailure({
    executable: "/home/me/.t3/tools/chrome-headless-shell/linux64/154/chrome-headless-shell",
    output: input.output,
    setupCommand: "sudo t3 browser setup",
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.Platform, input.platform),
    Effect.provideService(HostProcess.UserId, input.uid ?? 1000),
    Effect.map((error) => ({ error, commands })),
  );
};

describe("diagnoseLaunchFailure", () => {
  it.effect("names every library the loader cannot find", () =>
    Effect.gen(function* () {
      const { error } = yield* diagnose({
        platform: "linux",
        output: "error while loading shared libraries: libglib-2.0.so.0",
        ldd: LDD_IN_BARE_DEBIAN,
      });
      expect(error).toMatchObject({
        _tag: "PreviewBrowserLibrariesError",
        libraries: ["libglib-2.0.so.0", "libnss3.so", "libX11.so.6"],
      });
      expect(error?.message).toContain("Run `sudo t3 browser setup` on the host");
    }),
  );

  it.effect("trusts the browser's own start over ldd", () =>
    Effect.gen(function* () {
      // NixOS: ldd lists libraries that nix-ld still provides to the real loader.
      const { error } = yield* diagnose({
        platform: "linux",
        output: "crashed",
        ldd: LDD_IN_BARE_DEBIAN,
        version: "Google Chrome for Testing 154.0.8037.92\n",
      });
      expect(error).toBeUndefined();
    }),
  );
});

describe("sandboxBlocked", () => {
  /** A Linux host restricting user namespaces, with the given files; others are unreadable. */
  const host = (files: Readonly<Record<string, string>>) =>
    PreviewBrowserHost.sandboxBlocked.pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFileString: (path) =>
            path in files
              ? Effect.succeed(files[path]!)
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFileString",
                    pathOrDescriptor: path,
                  }),
                ),
          exists: (path) => Effect.succeed(path in files),
        }),
      ),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
  const restricted = { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n" };
  const profile = {
    [PreviewBrowserHost.APPARMOR_PROFILE_PATH]: PreviewBrowserHost.APPARMOR_PROFILE,
  };
  const loaded = (names: ReadonlyArray<string>) => ({
    "/sys/kernel/security/apparmor/profiles": names
      .map((name) => `${name} (unconfined)\n`)
      .join(""),
  });

  it.effect("still blocks when setup wrote the profile but could not load it", () =>
    Effect.gen(function* () {
      expect(yield* host({ ...restricted, ...profile, ...loaded(["firefox"]) })).toBe(true);
      expect(
        yield* host({
          ...restricted,
          ...profile,
          ...loaded(["firefox", "t3-chrome-headless-shell"]),
        }),
      ).toBe(false);
    }),
  );

  it.effect("goes by the profile file where the loaded profiles cannot be read", () =>
    Effect.gen(function* () {
      expect(yield* host(restricted)).toBe(true);
      expect(yield* host({ ...restricted, ...profile })).toBe(false);
    }),
  );
});

describe("runHostSetup", () => {
  /** A host whose `sudo -n` prints `output` and exits with `exitCode`. */
  const sudo = (output: string, exitCode: number) => {
    const commands: Array<string> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const { command: name, args } = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        commands.push([name, ...args].join(" "));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.make(new TextEncoder().encode(output)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    return { spawner, commands };
  };
  /** Needs setup until `fixed()` runs. */
  const host = () => {
    let needs = true;
    return { needsSetup: Effect.sync(() => needs), fix: () => (needs = false) };
  };
  const setup = (
    state: { readonly needsSetup: Effect.Effect<boolean> },
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  ) =>
    PreviewBrowserHost.runHostSetup({
      needsSetup: state.needsSetup,
      argv: ["/opt/t3/t3", "browser", "setup", "--mode", "headed", "--base-dir", "/home/me/.t3"],
      command: "sudo t3 browser setup --mode headed",
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  it.effect("runs the server's own setup with sudo -n and reports the host ready", () =>
    Effect.gen(function* () {
      const state = host();
      const { spawner, commands } = sudo("This host is ready to show T3's browser.\n", 0);
      const wrapped = ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(Effect.tap(() => Effect.sync(state.fix))),
      );
      expect(yield* setup(state, wrapped)).toEqual({ _tag: "Ready", ranSetup: true });
      expect(commands).toEqual([
        "sudo -n /opt/t3/t3 browser setup --mode headed --base-dir /home/me/.t3",
      ]);
    }),
  );

  it.effect("hands back the command when sudo needs a password", () =>
    Effect.gen(function* () {
      const { spawner } = sudo("sudo: a password is required\n", 1);
      expect(yield* setup(host(), spawner)).toEqual({
        _tag: "NeedsPassword",
        command: "sudo t3 browser setup --mode headed",
      });
    }),
  );

  it.effect("does not run sudo when the host is already set up", () =>
    Effect.gen(function* () {
      const state = host();
      state.fix();
      const { spawner, commands } = sudo("", 0);
      expect(yield* setup(state, spawner)).toEqual({ _tag: "Ready", ranSetup: false });
      expect(commands).toEqual([]);
    }),
  );

  it.effect("fails with setup's own output when it finished without fixing the host", () =>
    Effect.gen(function* () {
      const { spawner } = sudo("Install Xvfb with your package manager, then run this again.\n", 0);
      expect(yield* setup(host(), spawner)).toEqual({
        _tag: "Failed",
        command: "sudo t3 browser setup --mode headed",
        detail: "Install Xvfb with your package manager, then run this again.",
      });
    }),
  );
});

describe("headedDisplay", () => {
  const display = (input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly sockets?: Readonly<Record<string, number>>;
  }) =>
    PreviewBrowserHost.headedDisplay.pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readDirectory: (path) =>
            path === "/tmp/.X11-unix"
              ? Effect.succeed(Object.keys(input.sockets ?? {}))
              : Effect.succeed([]),
          stat: (path) =>
            Effect.succeed({
              uid: Option.some(input.sockets?.[path.split("/").at(-1)!] ?? -1),
            } as FileSystem.File.Info),
        }),
      ),
      Effect.provide(Path.layer),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 1001),
      // An empty PATH finds no Xvfb.
      Effect.provideService(HostProcess.Environment, { PATH: "", ...input.env }),
    );

  it.effect("uses the server's DISPLAY first", () =>
    Effect.gen(function* () {
      expect(yield* display({ env: { DISPLAY: ":5" }, sockets: { X99: 1001 } })).toEqual({
        _tag: "display",
        display: ":5",
      });
    }),
  );

  it.effect("finds a display this user runs, such as a VNC server, and skips other users'", () =>
    Effect.gen(function* () {
      expect(yield* display({ sockets: { X0: 0, X99: 1001, X100: 1001 } })).toEqual({
        _tag: "display",
        display: ":99",
      });
    }),
  );

  it.effect("needs setup when no display runs and Xvfb is missing", () =>
    Effect.gen(function* () {
      expect(yield* display({ sockets: { X0: 0 } })).toEqual({ _tag: "none" });
    }),
  );
});
