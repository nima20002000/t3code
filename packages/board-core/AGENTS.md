# board-core (fork-owned)

Pure board model, result protocol, routing, run views and the `/api/board` contract shared by the server and web board. No I/O and no imports from `apps/*`; only `@t3tools/contracts`, `effect` and relative imports. Upstream t3 never touches this package. See `/FORK.md`.
