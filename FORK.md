# Board fork

Board-owned code lives in `packages/board-core/`, `apps/server/src/board/`, and
`apps/web/src/board/`. Keep upstream edits small and use the public service
interfaces. Do not add board commands to the central RPC union or core migration
list. Board migrations will use their own `board_migrations` table.

## Upstream touch points

These files are the complete set of upstream integration points to check during
a merge (the server route is reserved for the later server phase):

- `apps/server/src/server.ts`: mount the board HTTP layer at the route merge.
- `apps/server/package.json`: the `@t3tools/board-core` workspace dependency.
- `apps/web/package.json`: `@t3tools/board-core` and `@xyflow/react` dependencies.
- `apps/web/src/routes/_chat.tsx`: mount the board engine.
- `apps/web/src/routes/_chat.board.tsx`: the board route.
- `apps/web/src/components/AppSidebarLayout.tsx`: hide the sidebar on the board.
- `apps/web/src/components/Sidebar.tsx` and `apps/web/src/components/sidebar/SidebarChrome.tsx`:
  board navigation.
- `apps/web/src/components/sidebar/mainAppLocation.ts`: board location.
- `apps/web/src/routeTree.gen.ts`: generated board route registration.
- `pnpm-lock.yaml`: workspace and board dependency lock entries.

Fork tooling is `FORK.md`, `scripts/fork-sync.sh`, and the fork-only
`.github/workflows/board-*.yml` workflows. Keep new board code in the owned
folders; do not patch upstream internals to make the board work.

## Sync and test policy

Run `scripts/fork-sync.sh` from a clean `board/mvp` checkout. It fetches upstream,
selects and merges the highest stable `vX.Y.Z` upstream tag, reports conflicted
files for comparison with the touch points above, and runs all board-owned tests.
After resolving a conflicted merge, commit it and run `scripts/fork-sync.sh --tests`.
It never merges `main`, preview tags, or nightly tags. Resolve conflicts before
rerunning the board tests. Keep the VPS on the published stable `t3` release.

Never run upstream test suites. Board CI typechecks board-core, web, and the
server workspace (named `t3`); it runs only changed tests under
`packages/board-core`, `apps/server/src/board`, and `apps/web/src/board`, plus
board-owned seam tests named `*.seam.test.ts` or `*.seam.test.tsx` on every push.
A manual CI run may name only board-owned test paths. Seam tests must exercise
real upstream interfaces while replacing only the necessary external transport.
There is no nightly upstream canary. A `*.published.seam.test.ts` version-skew
seam runs only on sync or by explicit selection; once it exists, it should check
the latest published stable `t3` release.
