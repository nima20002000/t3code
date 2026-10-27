# Server board (fork-owned)

The durable board engine (BoardStore, TaskEngine, drivers, schedules, `/api/board` + SSE). Everything outside this folder is upstream t3.

- Import upstream server code only through `./upstream.ts`; add a re-export there when you need something new. Tests and testkits may import upstream harnesses directly.
- Never edit upstream files to make the board work. The only allowed upstream edits are the touch points in `/FORK.md`.
- Board tables use their own migrator (`board_migrations`); never add entries to the core migration list.
- Run `node scripts/fork-boundary.mjs` and `node scripts/board-test.mjs` before pushing.
- Whatever t3 already supports, use it; never reinvent it. Threads, launch, sending, waiting, interrupts, auth, pairing, scheduling and persistence come from t3 services through `./upstream.ts`. Board code adds only what t3 does not have: the graph, runs, routing and their durable state.
