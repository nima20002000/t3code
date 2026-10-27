#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

is_board_test() {
  [[ "$1" =~ ^(packages/board-core|apps/server/src/board|apps/web/src/board)/[a-zA-Z0-9_./-]+\.test\.(ts|tsx)$ && "$1" != *..* ]]
}

run_board_tests() {
  local selection="$1" file base
  local -a candidates=() core=() server=() web=() browser=()
  if [[ -n "${INPUT_TESTS:-}" ]]; then
    read -r -a candidates <<< "$INPUT_TESTS"
  elif [[ "$selection" == changed ]]; then
    base="$(git merge-base origin/main HEAD)"
    while IFS= read -r -d '' file; do candidates+=("$file"); done < <(
      git diff --name-only -z --no-renames --diff-filter=ACMRT "$base" HEAD -- \
        packages/board-core apps/server/src/board apps/web/src/board
    )
    while IFS= read -r -d '' file; do
      if [[ "$file" == *.seam.test.ts || "$file" == *.seam.test.tsx ]]; then candidates+=("$file"); fi
    done < <(git ls-files -z -- packages/board-core apps/server/src/board apps/web/src/board)
  else
    while IFS= read -r -d '' file; do candidates+=("$file"); done < <(
      git ls-files -z -- packages/board-core apps/server/src/board apps/web/src/board
    )
  fi

  local -A seen=()
  for file in "${candidates[@]}"; do
    if ! is_board_test "$file"; then
      if [[ -n "${INPUT_TESTS:-}" ]]; then
        printf 'Not a board-owned test: %s\n' "$file" >&2
        return 1
      fi
      continue
    fi
    if ! git cat-file -e "HEAD:$file" 2>/dev/null; then
      printf 'Test does not exist in HEAD: %s\n' "$file" >&2
      return 1
    fi
    if [[ "$selection" == changed && -z "${INPUT_TESTS:-}" && ( "$file" == *.published.seam.test.ts || "$file" == *.published.seam.test.tsx ) ]]; then continue; fi
    [[ -n "${seen[$file]:-}" ]] && continue
    seen[$file]=1
    case "$file" in
      packages/board-core/*) core+=("${file#packages/board-core/}") ;;
      apps/server/src/board/*) server+=("${file#apps/server/}") ;;
      apps/web/src/board/*.browser.test.ts|apps/web/src/board/*.browser.test.tsx) browser+=("${file#apps/web/}") ;;
      apps/web/src/board/*) web+=("${file#apps/web/}") ;;
    esac
  done
  printf 'Board tests: %s\n' "${!seen[*]:-none}"
  if ((${#core[@]})); then (cd packages/board-core && vp test run --config ../../vite.config.ts --dir . "${core[@]}"); fi
  if ((${#server[@]})); then (cd apps/server && vp test run "${server[@]}"); fi
  if ((${#web[@]})); then (cd apps/web && vp test run --project unit "${web[@]}"); fi
  if ((${#browser[@]})); then
    if [[ "${CI:-}" == true ]]; then (cd apps/web && vp exec playwright install --with-deps chromium); fi
    (cd apps/web && vp test run --project browser "${browser[@]}")
  fi
}

if [[ "${1:-}" == --ci && $# == 1 ]]; then
  run_board_tests changed
  exit
fi
if [[ "${1:-}" == --tests && $# == 1 ]]; then
  unset INPUT_TESTS
  run_board_tests all
  exit
fi
if (($#)); then
  printf 'Usage: %s [--ci|--tests]\n' "$0" >&2
  exit 2
fi
if [[ "$(git branch --show-current)" != board/mvp ]]; then
  printf 'Switch to board/mvp before syncing.\n' >&2
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
unset INPUT_TESTS
run_board_tests all
