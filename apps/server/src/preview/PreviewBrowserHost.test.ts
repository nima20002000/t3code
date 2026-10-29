import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
