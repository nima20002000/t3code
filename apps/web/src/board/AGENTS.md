# Web board (fork-owned)

The `/board` page, its toolbar, node panel and the client for `/api/board`. Everything outside this folder is upstream t3.

- Import upstream web code (ui components, state, hooks) only through `./upstream.ts`; add a re-export there when you need something new. Tests may import upstream test helpers directly.
- Never edit upstream components to make the board work. The only allowed upstream edits are the touch points in `/FORK.md`.
- Run `node scripts/fork-boundary.mjs` and `node scripts/board-test.mjs` before pushing.
