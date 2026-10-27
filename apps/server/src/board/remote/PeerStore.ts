import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { BoardStore } from "../BoardStore.ts";

export interface Peer {
  readonly id: string;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly url: string;
  readonly bearer: string;
}

export interface PeerStore {
  readonly get: (environmentId: EnvironmentId) => Effect.Effect<Peer | undefined, Error>;
  readonly list: () => Effect.Effect<ReadonlyArray<Peer>, Error>;
  readonly put: (peer: Peer) => Effect.Effect<void, Error>;
  readonly remove: (environmentId: EnvironmentId) => Effect.Effect<void, Error>;
}

export function makeBoard(store: BoardStore["Service"]): PeerStore {
  return {
    get: store.getPeer,
    list: store.listPairedPeers,
    put: (peer) =>
      store.transaction(
        Effect.gen(function* () {
          const visible = yield* store.putPeer(peer);
          yield* store.appendEvent({ kind: "peer.upserted", peer: visible });
        }),
      ),
    remove: (id) =>
      store.transaction(
        Effect.gen(function* () {
          const peer = yield* store.getPeer(id);
          if (!peer) return;
          yield* store.deletePeer(id);
          yield* store.appendEvent({ kind: "peer.deleted", peerId: peer.id });
        }),
      ),
  };
}

export function makeMemory(): PeerStore {
  const peers = new Map<EnvironmentId, Peer>();
  return {
    get: (id) => Effect.sync(() => peers.get(id)),
    list: () => Effect.sync(() => Array.from(peers.values())),
    put: (peer) => Effect.sync(() => void peers.set(peer.environmentId, peer)),
    remove: (id) => Effect.sync(() => void peers.delete(id)),
  };
}
