import {
  BoardInternalError,
  BoardInvalidRequestError,
  BoardNotFoundError,
  type BoardPairPeerInput,
  type BoardPeer,
} from "@t3tools/board-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { SqlError } from "effect/sql/SqlError";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as PeerPairing from "./remote/PeerPairing.ts";
import * as PeerStore from "./remote/PeerStore.ts";
import * as RemoteDriver from "./remote/RemoteDriver.ts";

export class BoardPeers extends Context.Service<
  BoardPeers,
  {
    readonly pair: (
      input: BoardPairPeerInput,
    ) => Effect.Effect<BoardPeer, BoardInvalidRequestError | BoardInternalError>;
    readonly remove: (id: string) => Effect.Effect<void, SqlError | BoardNotFoundError>;
  }
>()("t3/board/BoardPeers") {}

const make = Effect.gen(function* () {
  const store = yield* BoardStore.BoardStore;
  const drivers = yield* DriverRegistry.DriverRegistry;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const localEnvironmentId = yield* environment.getEnvironmentId;
  const peers = PeerStore.makeBoard(store);
  const driver = RemoteDriver.make(peers);
  const lock = yield* Semaphore.make(1);
  const pairingStore: PeerStore.PeerStore = {
    ...peers,
    put: (peer) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          peers.put(peer).pipe(Effect.andThen(drivers.register(peer.environmentId, driver))),
        ),
      ),
  };
  const pair = Effect.fn("BoardPeers.pair")(function* (input: BoardPairPeerInput) {
    const peer = yield* PeerPairing.pair({
      ...input,
      localEnvironmentId,
      store: pairingStore,
    }).pipe(
      Effect.catchTags({
        PeerPairingError: (cause) => {
          if (cause.stage === "store") {
            return Effect.logError("Could not save paired board machine", {
              stage: cause.stage,
            }).pipe(
              Effect.andThen(
                Effect.fail(new BoardInternalError({ message: "Could not save machine." })),
              ),
            );
          }
          const message =
            cause.stage === "local"
              ? "This machine is already the board hub."
              : cause.stage === "address"
                ? "Enter a pairing link, or a pairing code and machine address."
                : cause.stage === "protocol"
                  ? "This machine uses an incompatible orchestration protocol."
                  : cause.stage === "descriptor"
                    ? "Could not reach the machine or read its identity."
                    : "Could not exchange the pairing credential. Check that it is valid and try again.";
          return Effect.fail(new BoardInvalidRequestError({ message }));
        },
      }),
    );
    return {
      id: peer.id,
      name: peer.name,
      environmentId: peer.environmentId,
      url: peer.url,
      status: "connected" as const,
    };
  });
  const remove = Effect.fn("BoardPeers.remove")(function* (id: string) {
    yield* lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const peer = (yield* store.listPairedPeers()).find((entry) => entry.id === id);
          if (!peer) return yield* new BoardNotFoundError({ message: "Machine not found." });
          yield* store.transaction(
            Effect.gen(function* () {
              yield* store.deletePeer(peer.environmentId);
              yield* store.appendEvent({ kind: "peer.deleted", peerId: peer.id });
            }),
          );
          yield* drivers.remove(peer.environmentId);
        }),
      ),
    );
  });
  return BoardPeers.of({ pair, remove });
});

export const layer = Layer.effect(BoardPeers, make);
