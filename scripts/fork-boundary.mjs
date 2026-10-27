#!/usr/bin/env node
// Fails when the fork crosses its boundary with upstream t3:
// 1. a file outside the board folders changed and is not a touch point listed in FORK.md;
// 2. board source imports upstream code anywhere but its folder's upstream.ts gateway.
// Tests and testkits are exempt from 2: seam tests drive real upstream harnesses on purpose.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
process.chdir(root);

const BOARD_DIRS = ["packages/board-core", "apps/server/src/board", "apps/web/src/board"];
const inBoard = (file) => BOARD_DIRS.some((dir) => file.startsWith(`${dir}/`));
const problems = [];

const forkMd = readFileSync("FORK.md", "utf8");
const touchSection = forkMd
  .split(/^## /m)
  .find((section) => section.startsWith("Upstream touch points"));
if (!touchSection) throw new Error("FORK.md has no '## Upstream touch points' section");
const touchPoints = new Set(
  [...touchSection.matchAll(/`([^`\s]+)`/g)]
    .map((match) => match[1])
    .filter((path) => path.includes(".")),
);
const FORK_TOOLING =
  /^(FORK\.md|scripts\/(fork-[\w-]+|board-[\w-]+)\.(sh|mjs)|\.github\/workflows\/board-[\w-]+\.yml)$/;

const base =
  process.env.FORK_BASE ||
  git("merge-base", "HEAD", process.env.FORK_UPSTREAM_REF || "origin/main");
// Working tree against the base, plus untracked files, so the check also covers uncommitted work.
const changed = [
  ...new Set([
    ...git("diff", "--name-only", "--no-renames", base).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ]),
].filter(Boolean);
for (const file of changed) {
  if (inBoard(file) || FORK_TOOLING.test(file) || touchPoints.has(file)) continue;
  problems.push(
    `${file}: upstream file changed but not listed under "Upstream touch points" in FORK.md`,
  );
}

const SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const isTest = (file) => /\.(test|testkit)\.tsx?$/.test(file);
for (const dir of BOARD_DIRS) {
  const files = git("ls-files", "-co", "--exclude-standard", dir)
    .split("\n")
    .filter((file) => /\.tsx?$/.test(file) && !isTest(file) && file !== `${dir}/upstream.ts`);
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      const target = specifier.startsWith("~/")
        ? `apps/web/src/${specifier.slice(2)}`
        : specifier.startsWith(".")
          ? relative(root, resolve(dirname(file), specifier))
          : undefined;
      if (target === undefined || target.startsWith(`${dir}/`)) continue;
      problems.push(
        dir === "packages/board-core"
          ? `${file}: board-core is pure and may not import ${specifier}`
          : `${file}: imports upstream ${specifier}; go through ${dir}/upstream.ts`,
      );
    }
  }
}

// An upstream merge rewrites AGENTS.md; the fork banner must survive it.
if (!readFileSync("AGENTS.md", "utf8").includes("**This checkout is the board fork.**"))
  problems.push(
    "AGENTS.md: the board fork banner at the top is missing (lost in an upstream merge?)",
  );

if (problems.length) {
  console.error(`Fork boundary violations (base ${base.slice(0, 10)}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `Fork boundary ok: ${changed.length} changed files checked against ${base.slice(0, 10)}.`,
);
