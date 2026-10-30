import { BOARD_CLIENT_LABEL, type BoardMembership } from "@t3tools/board-core";
import * as Effect from "effect/Effect";
import type * as BoardService from "./BoardService.ts";
import { EnvironmentAuth } from "./upstream.ts";

/** A computer is on a board once it has machines of its own or a hub paired with it. */
export const membership = Effect.fn("BoardMembership.membership")(function* (
  board: BoardService.BoardService["Service"],
) {
  const peers = yield* board.listPeers();
  if (peers.length > 0) return { onBoard: true } satisfies BoardMembership;
  const auth = yield* EnvironmentAuth;
  const sessions = yield* auth.listSessions();
  return {
    onBoard: sessions.some((session) => session.client.label === BOARD_CLIENT_LABEL),
  } satisfies BoardMembership;
});
