#!/usr/bin/env node
// Cache each board test pass against its imports, configuration, and lockfile.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const root = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
process.chdir(root);
const cacheDir =
  process.env.BOARD_TEST_CACHE ?? NodePath.join(NodeOS.homedir(), ".cache", "t3-board-tests");
const proofsFile = NodePath.join(cacheDir, "proofs.json");
const BOARD_DIRS = ["packages/board-core", "apps/server/src/board", "apps/web/src/board"];
const isTest = (file) => /\.test\.tsx?$/.test(file);

const tracked = NodeChildProcess.execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  encoding: "utf8",
  maxBuffer: 64 << 20,
})
  .split("\n")
  .filter(Boolean);
const trackedSet = new Set(tracked);

const packageDirs = new Map();
for (const file of tracked) {
  if (!file.endsWith("/package.json")) continue;
  const name = JSON.parse(NodeFS.readFileSync(file, "utf8")).name;
  if (name) packageDirs.set(name, NodePath.dirname(file));
}
const packageFileCache = new Map();
const packageFiles = (dir) => {
  let files = packageFileCache.get(dir);
  if (!files) {
    files = tracked.filter(
      (file) => file.startsWith(`${dir}/`) && /\.(m?[jt]sx?|json)$/.test(file),
    );
    packageFileCache.set(dir, files);
  }
  return files;
};

const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];
function resolveFile(base) {
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = base + extension;
    if (trackedSet.has(candidate)) return candidate;
  }
  if (base.endsWith(".js")) return resolveFile(base.slice(0, -3));
  return undefined;
}

const SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|vi\.mock\(\s*["']([^"']+)["']/g;

// Returns repository files a file depends on; whole workspace packages for bare `@t3tools/*` imports.
function dependencies(file) {
  const text = NodeFS.readFileSync(file, "utf8");
  const found = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier.startsWith(".")) {
      const target = resolveFile(
        NodePath.relative(root, NodePath.resolve(NodePath.dirname(file), specifier)),
      );
      if (target) found.push(target);
    } else if (specifier.startsWith("~/")) {
      const target = resolveFile(`apps/web/src/${specifier.slice(2)}`);
      if (target) found.push(target);
    } else {
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      const dir = packageDirs.get(name);
      if (dir) for (const target of packageFiles(dir)) found.push(target);
    }
  }
  return found;
}

const SHARED_INPUTS = [
  "pnpm-lock.yaml",
  "package.json",
  "vite.config.ts",
  "tsconfig.base.json",
  "scripts/board-test.mjs",
];
function projectOf(file) {
  if (file.startsWith("packages/board-core/")) return "core";
  if (file.startsWith("apps/server/")) return "server";
  return /\.browser\.test\.tsx?$/.test(file) ? "browser" : "web";
}
const PROJECT_INPUTS = {
  core: ["packages/board-core/package.json", "packages/board-core/tsconfig.json"],
  server: [
    "apps/server/package.json",
    "apps/server/vite.config.ts",
    "apps/server/tsconfig.json",
    ...tracked.filter((file) => /^apps\/server\/src\/testUtils\/.*\.setup\.ts$/.test(file)),
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
  ],
  web: [
    "apps/web/package.json",
    "apps/web/vite.config.ts",
    "apps/web/tsconfig.json",
    ...tracked.filter((file) => file.startsWith("apps/web/test/")),
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
  ],
};
PROJECT_INPUTS.browser = PROJECT_INPUTS.web;

const blobHash = new Map();
const hashOf = (file) => {
  let hash = blobHash.get(file);
  if (hash === undefined) {
    hash = NodeFS.existsSync(file)
      ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex")
      : "-";
    blobHash.set(file, hash);
  }
  return hash;
};

const depsCache = new Map();
function keyOf(test) {
  const seen = new Set();
  const roots = [test, ...SHARED_INPUTS, ...PROJECT_INPUTS[projectOf(test)]];
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(m?[jt]sx?)$/.test(file) || !NodeFS.existsSync(file)) continue;
    let deps = depsCache.get(file);
    if (!deps) depsCache.set(file, (deps = dependencies(file)));
    for (const dep of deps) stack.push(dep);
  }
  const hash = NodeCrypto.createHash("sha256").update(`v1\0${process.version}\0${test}\0`);
  for (const file of [...seen].sort()) hash.update(`${file}\0${hashOf(file)}\0`);
  return hash.digest("hex");
}

const args = process.argv.slice(2);
const full = args.includes("--full");
const named = args.filter((arg) => !arg.startsWith("--"));
const tests = named.length
  ? named
  : tracked.filter((file) => isTest(file) && BOARD_DIRS.some((dir) => file.startsWith(`${dir}/`)));
for (const test of tests) {
  if (
    !BOARD_DIRS.some((dir) => test.startsWith(`${dir}/`)) ||
    !isTest(test) ||
    !NodeFS.existsSync(test)
  ) {
    console.error(`Not a board-owned test: ${test}`);
    process.exit(2);
  }
}

const proofs = NodeFS.existsSync(proofsFile)
  ? JSON.parse(NodeFS.readFileSync(proofsFile, "utf8"))
  : {};
const keys = new Map(tests.map((test) => [test, keyOf(test)]));
const toRun = tests.filter((test) => full || named.length || !proofs[keys.get(test)]);
const cached = tests.filter((test) => !toRun.includes(test));
console.log(`Board tests: ${toRun.length} to run, ${cached.length} cached`);
for (const test of cached) console.log(`  cached  ${test}`);
for (const test of toRun) console.log(`  run     ${test}`);

const COMMANDS = {
  core: { cwd: "packages/board-core", args: ["--config", "../../vite.config.ts", "--dir", "."] },
  server: { cwd: "apps/server", args: [] },
  web: { cwd: "apps/web", args: ["--project", "unit"] },
  browser: { cwd: "apps/web", args: ["--project", "browser"] },
};
NodeFS.mkdirSync(cacheDir, { recursive: true });
let failed = false;
for (const [project, command] of Object.entries(COMMANDS)) {
  const files = toRun.filter((test) => projectOf(test) === project);
  if (!files.length) continue;
  if (project === "browser" && process.env.CI === "true") {
    NodeChildProcess.spawnSync("vp", ["exec", "playwright", "install", "--with-deps", "chromium"], {
      cwd: command.cwd,
      stdio: "inherit",
    });
  }
  const report = NodePath.join(cacheDir, `report-${process.pid}-${project}.json`);
  const result = NodeChildProcess.spawnSync(
    "vp",
    [
      "test",
      "run",
      ...command.args,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${report}`,
      ...files.map((file) => NodePath.relative(command.cwd, file)),
    ],
    { cwd: command.cwd, stdio: "inherit" },
  );
  if (result.status !== 0) failed = true;
  if (!NodeFS.existsSync(report)) continue;
  for (const fileResult of JSON.parse(NodeFS.readFileSync(report, "utf8")).testResults ?? []) {
    const test = NodePath.relative(root, fileResult.name);
    const passed =
      fileResult.status === "passed" &&
      fileResult.assertionResults.length > 0 &&
      fileResult.assertionResults.every((assertion) => assertion.status === "passed");
    if (passed && keys.has(test)) proofs[keys.get(test)] = { test, at: new Date().toISOString() };
  }
  NodeFS.rmSync(report, { force: true });
}
NodeFS.writeFileSync(proofsFile, `${JSON.stringify(proofs, null, 1)}\n`);
process.exit(failed ? 1 : 0);
