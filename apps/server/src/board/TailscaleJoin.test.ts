import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { readTailscaleStatus, tailscaleJoinCommand } from "./TailscaleJoin.ts";

// Runs the join as the administrator prompt would, against fake tailscale/curl tools that log their calls.
const runJoin = (tools: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "board-tailscale-test-" });
    const log = path.join(dir, "log");
    const bin = path.join(dir, "bin");
    yield* fs.makeDirectory(bin);
    for (const tool of ["sh", "chmod", "cat", "mktemp", "rm"])
      yield* fs.symlink(`/bin/${tool}`, path.join(bin, tool));
    for (const [name, body] of Object.entries(tools))
      yield* fs.writeFileString(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const keyFile = path.join(dir, "key");
    yield* fs.writeFileString(keyFile, "tskey-auth-secret");
    const { command, args } = tailscaleJoinCommand({ keyFile, operator: "alice" });
    const [shell = "", ...rest] = args;
    const child = yield* spawner.spawn(
      ChildProcess.make(shell, rest, { env: { PATH: bin, BIN: bin, LOG: log } }),
    );
    yield* child.stdout.pipe(Stream.runDrain);
    const status = Number(yield* child.exitCode);
    const logged = (yield* fs.exists(log)) ? yield* fs.readFileString(log) : "";
    return { command, argv: args.join(" "), keyFile, status, log: logged };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("tailscaleJoinCommand", () => {
  it.live("asks for administrator permission once and joins with the key from its file", () =>
    Effect.gen(function* () {
      const run = yield* runJoin({ tailscale: 'echo "tailscale $*" >> "$LOG"' });
      assert.equal(run.command, "pkexec");
      assert.equal(run.status, 0);
      assert.equal(
        run.log,
        `tailscale up --auth-key=file:${run.keyFile} --operator=alice --reset --force-reauth\n`,
      );
      assert.notInclude(run.argv, "tskey-auth-secret");
    }),
  );

  it.live("installs Tailscale with its official installer when it is missing, then joins", () =>
    Effect.gen(function* () {
      const run = yield* runJoin({
        curl: [
          'echo "curl $*" >> "$LOG"',
          'while [ "$#" -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done',
          'cat "$BIN/installer" > "$out"',
        ].join("\n"),
        // Like the real installer, it leaves a working tailscale on PATH.
        installer: `printf '#!/bin/sh\\necho "tailscale $*" >> "$LOG"\\n' > "$BIN/tailscale"; chmod +x "$BIN/tailscale"`,
      });
      assert.equal(run.status, 0);
      assert.include(run.log, "curl -fsSL https://tailscale.com/install.sh");
      assert.include(run.log, `tailscale up --auth-key=file:${run.keyFile}`);
    }),
  );

  it.live("stops with its own exit code when the installer cannot be downloaded", () =>
    Effect.gen(function* () {
      const run = yield* runJoin({ curl: "exit 6" });
      assert.equal(run.status, 90);
      assert.notInclude(run.log, "tailscale up");
    }),
  );
});

describe("readTailscaleStatus", () => {
  const status = (json: unknown) => readTailscaleStatus({ code: 0, stdout: JSON.stringify(json) });

  it("reports the address and tailnet only while Tailscale is running", () => {
    const self = { TailscaleIPs: ["fd7a:115c::1", "100.64.0.7"] };
    assert.deepEqual(
      status({
        BackendState: "Running",
        CurrentTailnet: { Name: "owner@example.com" },
        Self: self,
      }),
      { installed: true, ipv4: "100.64.0.7", tailnet: "owner@example.com" },
    );
    assert.deepEqual(status({ BackendState: "Stopped", Self: self }), {
      installed: true,
      ipv4: null,
      tailnet: null,
    });
  });

  it("tells a missing Tailscale from one that is not logged in", () => {
    assert.deepEqual(readTailscaleStatus({ code: "missing", stdout: "" }), {
      installed: false,
      ipv4: null,
      tailnet: null,
    });
    assert.deepEqual(readTailscaleStatus({ code: 1, stdout: "not json" }), {
      installed: true,
      ipv4: null,
      tailnet: null,
    });
  });
});
