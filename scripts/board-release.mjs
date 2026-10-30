#!/usr/bin/env node
// Builds a fork release for Linux x64: the desktop AppImage (with its updater pointed at the fork),
// the `t3` server archive, and SHA256SUMS. Package versions are bumped only for the build and put
// back afterwards. It never publishes; it prints the `gh release create` command to run.
//
//   node scripts/board-release.mjs [--version 0.1.5-board.4] [--out release/board-<version>]
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const RELEASE_REPOSITORY = "nima20002000/t3code";
const PACKAGE_FILES = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const BOARD = /^v?(\d+)\.(\d+)\.(\d+)-board\.(\d+)$/;
const parts = (match) => match.slice(1).map(Number);
const compare = (a, b) => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** Every fork release is `<upstream base>-board.<n>` and must sort above all earlier fork releases. */
export function nextBoardVersion(input) {
  const bases = input.tags.flatMap((tag) => {
    const match = STABLE.exec(tag);
    return match ? [parts(match)] : [];
  });
  const base = bases.toSorted(compare).at(-1);
  if (!base) throw new Error("No upstream vX.Y.Z tag is merged into this checkout.");
  const released = input.tags.flatMap((tag) => {
    const match = BOARD.exec(tag);
    return match ? [parts(match)] : [];
  });
  const newest = released.toSorted(compare).at(-1);
  const version = (numbers) => `${numbers.slice(0, 3).join(".")}-board.${numbers[3]}`;
  if (input.requested !== undefined) {
    const match = BOARD.exec(input.requested);
    if (!match) throw new Error(`${input.requested} is not a fork version like 0.1.5-board.4.`);
    if (newest && compare(parts(match), newest) <= 0)
      throw new Error(
        `${input.requested} must be newer than the last fork release ${version(newest)}.`,
      );
    return version(parts(match));
  }
  const sameBase = released.filter((numbers) => compare(numbers.slice(0, 3), base) === 0);
  const next = [...base, Math.max(0, ...sameBase.map((numbers) => numbers[3])) + 1];
  if (newest && compare(next, newest) <= 0)
    throw new Error(
      `The last fork release ${version(newest)} is newer than this checkout's upstream base ${base.join(".")}; pass --version.`,
    );
  return version(next);
}

let running;
let cancelled;

/** Runs one build step; a signal stops it and makes the build fail, so the versions are put back. */
function sh(command, args, options = {}) {
  if (cancelled) return Promise.reject(new Error(`Cancelled by ${cancelled}.`));
  console.log(`\n$ ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    running = NodeChildProcess.spawn(command, args, { stdio: "inherit", ...options });
    running.on("error", reject);
    running.on("exit", (code, signal) => {
      running = undefined;
      if (cancelled) reject(new Error(`Cancelled by ${cancelled}.`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ""} failed (${code ?? signal}).`));
    });
  });
}

const git = (...args) =>
  NodeChildProcess.execFileSync("git", args, { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const root = git("rev-parse", "--show-toplevel")[0];
  process.chdir(root);

  // Released versions live on the fork; without them a stale checkout could reuse a published number.
  let remoteTags;
  try {
    remoteTags = git("ls-remote", "--tags", "--refs", "origin", "v*-board.*").map((line) =>
      line.replace(/^.*refs\/tags\//, ""),
    );
  } catch {
    throw new Error(
      "Could not list the fork's release tags on origin, so the version cannot be checked.",
    );
  }
  const version = nextBoardVersion({
    tags: [
      ...git("tag", "--merged", "HEAD", "--list", "v*"),
      ...git("tag", "--list", "v*-board.*"),
      ...remoteTags,
    ],
    requested: flag("--version"),
  });
  const out = NodePath.resolve(flag("--out") ?? `release/board-${version}`);
  if (NodeFS.existsSync(out) && NodeFS.readdirSync(out).length > 0)
    throw new Error(`${out} is not empty; remove it or pass another --out.`);
  console.log(`Building fork release ${version} into ${out}`);
  NodeFS.mkdirSync(out, { recursive: true });

  const env = {
    ...process.env,
    PATH: `${NodePath.join(NodeOS.homedir(), ".cargo/bin")}:${process.env.PATH}`,
    T3CODE_DESKTOP_UPDATE_REPOSITORY: RELEASE_REPOSITORY,
    // The CLI executable must be built with the exact Node in engines; vp otherwise picks its newest.
    VP_NODE_VERSION: JSON.parse(NodeFS.readFileSync("package.json", "utf8")).engines.node,
  };
  const saved = PACKAGE_FILES.map((file) => [file, NodeFS.readFileSync(file)]);
  const restore = () => {
    for (const [file, contents] of saved) NodeFS.writeFileSync(file, contents);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      cancelled = signal;
      running?.kill(signal);
    });
  try {
    await sh("node", ["scripts/update-release-package-versions.ts", version], { env });
    const monitor = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "board-release-rm-"));
    await sh(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        "native/resource-monitor/Cargo.toml",
        "--target",
        "x86_64-unknown-linux-gnu",
      ],
      { env },
    );
    NodeFS.mkdirSync(NodePath.join(monitor, "linux-x64"));
    NodeFS.copyFileSync(
      "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
      NodePath.join(monitor, "linux-x64/t3-resource-monitor"),
    );
    await sh("vp", ["run", "--filter", "t3", "build"], { env });
    await sh("node", ["apps/server/scripts/cli.ts", "build-exe"], {
      env: { ...env, T3CODE_TELEMETRY_CHANNEL: "dev" },
    });
    await sh(
      "node",
      [
        "scripts/build-cli-archive.ts",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        version,
        "--resource-monitor-dir",
        monitor,
        "--output-dir",
        out,
      ],
      { env },
    );
    NodeFS.rmSync(monitor, { recursive: true, force: true });
    const archive = NodeFS.readdirSync(out).find((name) => name.endsWith(".tar.gz"));
    await sh(
      "node",
      [
        "scripts/smoke-cli-archive.ts",
        "--archive",
        NodePath.join(out, archive),
        "--expect-version",
        version,
      ],
      { env },
    );
    await sh(
      "node",
      [
        "scripts/build-desktop-artifact.ts",
        "--platform",
        "linux",
        "--target",
        "AppImage",
        "--arch",
        "x64",
        "--build-version",
        version,
        "--output-dir",
        out,
      ],
      { env },
    );
  } finally {
    restore();
  }
  for (const name of NodeFS.readdirSync(out))
    if (name === "builder-debug.yml") NodeFS.rmSync(NodePath.join(out, name));
  // The one-command installer is served as releases/latest/download/install.sh.
  NodeFS.copyFileSync("scripts/board-install.sh", NodePath.join(out, "install.sh"));
  const files = NodeFS.readdirSync(out)
    .filter((name) => name !== "SHA256SUMS")
    .sort();
  const sums = files.map((name) => {
    const hash = NodeCrypto.createHash("sha256").update(
      NodeFS.readFileSync(NodePath.join(out, name)),
    );
    return `${hash.digest("hex")}  ${name}`;
  });
  NodeFS.writeFileSync(NodePath.join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
  console.log(
    `\nBuilt ${version}:\n${[...files, "SHA256SUMS"].map((name) => `  ${out}/${name}`).join("\n")}`,
  );
  console.log(
    `\nTo publish (a full release, not a pre-release: the desktop updater only reads the latest full release):\n  gh release create v${version} --repo ${RELEASE_REPOSITORY} --target $(git rev-parse HEAD) --title "t3 ${version}" --latest ${out}/*`,
  );
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
