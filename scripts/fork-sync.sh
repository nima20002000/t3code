#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == --tests && $# == 1 ]]; then
  node scripts/board-test.mjs
  exit
fi
if (($#)); then
  printf 'Usage: %s [--tests]\n' "$0" >&2
  exit 2
fi
if [[ "$(git branch --show-current)" != board/main ]]; then
  printf 'Switch to board/main before syncing.\n' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Commit or stash your changes before syncing.\n' >&2
  exit 1
fi

git fetch upstream
stable="$(git ls-remote --tags --refs upstream | awk '$2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/ { sub("refs/tags/", "", $2); print $2 }' | sort -V | tail -n 1)"
if [[ -z "$stable" ]]; then
  printf 'No stable vX.Y.Z tag found on upstream.\n' >&2
  exit 1
fi
git fetch upstream "refs/tags/$stable:refs/tags/$stable"
printf 'Merging upstream stable tag %s\n' "$stable"
if ! git merge --no-edit "refs/tags/$stable"; then
  printf 'Merge failed. Conflicted files (compare with FORK.md touch points):\n' >&2
  git diff --name-only --diff-filter=U >&2
  exit 1
fi
node scripts/board-test.mjs
