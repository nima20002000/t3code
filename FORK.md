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
- `apps/web/src/routes/_chat.board.tsx`: the board route.
- `apps/web/src/routes/_chat.index.tsx`: open the app on the board once at startup.
- `apps/web/src/components/AppSidebarLayout.tsx`: call the board-owned sidebar visibility helper.
- `apps/web/src/components/Sidebar.tsx` and `apps/web/src/components/sidebar/SidebarChrome.tsx`:
  mount board-owned navigation components.
- `apps/web/src/components/sidebar/mainAppLocation.ts`: board location.
- `apps/web/src/routeTree.gen.ts`: generated board route registration.
- `apps/server/scripts/migrate-dev-db.ts` and `apps/server/scripts/migrate-dev-db.test.ts`: dev seeding
  also clears the board execution and peer tables.
- `apps/web/src/components/chat/composerNewThread.ts`, `apps/web/src/components/chat/useComposerMenuItems.ts`,
  `apps/web/src/components/chat/useComposerSend.ts`, `apps/web/src/components/chat/ChatComposer.tsx` and
  `apps/web/src/composer-logic.ts`: the composer's `/new` command, offered where a `ComposerNewThreadContext`
  handler is provided (the board's chat windows).
- `apps/web/src/browser/hostSetupRunner.ts` and `apps/web/src/browser/ServerBrowserSurface.tsx`: a browser whose
  host needs setup offers to run it, after confirming, where a `HostSetupRunnerContext` runner is provided
  (the board's browser windows run it in the agent's terminal).
- `apps/server/src/cli/browser.ts`, `apps/server/src/preview/PreviewBrowserHost.ts` and `apps/server/src/preview/PreviewBrowserHost.test.ts`: `t3 browser setup` finds
  sbin tools under `sudo env "PATH=$PATH"` and treats a written but unloaded AppArmor profile as not set up.
- `apps/web/src/index.css`: one `@import` of `board/styles/board.css`, so Tailwind and the lint rules know the board's classes.
- `packages/contracts/src/project.ts`, `packages/contracts/src/rpc.ts`, `apps/server/src/ws.ts`,
  `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/observability/RpcInstrumentation.ts`,
  and the new `apps/server/src/project/ProjectFolderRemoval.ts`:
  the `projects.removeFolder` RPC and `removeProjectFolder`, which deletes a project's own folder
  (never a root, home, a parent of home or a folder holding another project) when a workspace is deleted.
- `AGENTS.md`: one paragraph pointing agents at this file and the board folders.
- `pnpm-lock.yaml`: workspace and board dependency lock entries.

Board code reaches upstream only through one gateway per side:
`apps/server/src/board/upstream.ts` and `apps/web/src/board/upstream.ts`. They list every upstream
module the board depends on, so a merge that breaks the board shows up there. `board-core` imports
no upstream app code. `scripts/fork-boundary.mjs` enforces both rules and that no upstream file
outside this list changes; Board CI runs it. Tests are exempt from the gateway rule.

Fork tooling is `FORK.md`, `scripts/fork-sync.sh`, `scripts/fork-boundary.mjs`, `scripts/board-test.mjs`, and the fork-only
`.github/workflows/board-*.yml` workflows. Keep new board code in the owned
folders; do not patch upstream internals to make the board work.

## Sync and test policy

Run `scripts/fork-sync.sh` from a clean `board/main` checkout. It fetches upstream,
selects and merges the highest stable `vX.Y.Z` upstream tag, reports conflicted
files for comparison with the touch points above, and runs all board-owned tests.
After resolving a conflicted merge, commit it and run `scripts/fork-sync.sh --tests`.
It never merges `main`, preview tags, or nightly tags.

When a board fix corrects genuinely wrong behavior (a feature that stopped working, an overlap,
lost state), write the board test that fails on it first, then fix it, so the test suite catches it
coming back. Small visual tweaks (spacing, cursors, sizes) need no test.

Run board tests locally with `node scripts/board-test.mjs`. It keeps a pass per test file in
`~/.cache/t3-board-tests`, keyed by the file, everything it imports, setup files, configs and the
lockfile, and runs only files without a pass (`--full` runs all). CI restores the same cache. Resolve conflicts before
rerunning the board tests. Keep the VPS on the published stable `t3` release.

Never run upstream test suites. Board CI typechecks board-core, web, and the
server workspace (named `t3`); it runs only changed tests under
`packages/board-core`, `apps/server/src/board`, and `apps/web/src/board`, plus
board-owned seam tests named `*.seam.test.ts` or `*.seam.test.tsx` on every push.
The web layout seam uses `*.seam.browser.test.tsx` and runs with the browser project as a changed board test.
A manual CI run may name only board-owned test paths. Seam tests must exercise
real upstream interfaces while replacing only the necessary external transport.
The seams cover real orchestration services and settled replies; board migrations
sharing the existing SQLite database; the server HTTP/auth/SSE hook; pairing and
WS RPC against a second t3 server; and the board route, sidebar, and ChatView.
There is no nightly upstream canary. A `*.published.seam.test.ts` version-skew
seam runs only on sync or by explicit selection; once it exists, it should check
the latest published stable `t3` release.
