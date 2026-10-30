import { assert, it } from "@effect/vitest";
import { BOARD_CLIENT_LABEL, type BoardPeer } from "@t3tools/board-core";
import * as Effect from "effect/Effect";
import * as BoardMembership from "./BoardMembership.ts";
import type * as BoardService from "./BoardService.ts";
import { EnvironmentAuth } from "./upstream.ts";

const boardWith = (peers: ReadonlyArray<BoardPeer>) =>
  ({ listPeers: () => Effect.succeed(peers) }) as unknown as BoardService.BoardService["Service"];
const authWith = (labels: ReadonlyArray<string | undefined>) =>
  EnvironmentAuth.of({
    listSessions: () =>
      Effect.succeed(labels.map((label) => ({ client: label ? { label } : {} }) as never)),
  } as unknown as EnvironmentAuth["Service"]);

it.effect("a computer is on a board once a hub paired with it or it has machines", () =>
  Effect.gen(function* () {
    const fresh = yield* BoardMembership.membership(boardWith([])).pipe(
      Effect.provideService(EnvironmentAuth, authWith([undefined, "Chrome on Linux"])),
    );
    assert.deepStrictEqual(fresh, { onBoard: false });

    const added = yield* BoardMembership.membership(boardWith([])).pipe(
      Effect.provideService(EnvironmentAuth, authWith(["Chrome on Linux", BOARD_CLIENT_LABEL])),
    );
    assert.deepStrictEqual(added, { onBoard: true });

    const hub = yield* BoardMembership.membership(
      boardWith([{ id: "vps", name: "VPS" } as BoardPeer]),
    ).pipe(Effect.provideService(EnvironmentAuth, authWith([])));
    assert.deepStrictEqual(hub, { onBoard: true });
  }),
);
