import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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

export function makeMemory(): PeerStore {
  const peers = new Map<EnvironmentId, Peer>();
  return {
    get: (id) => Effect.sync(() => peers.get(id)),
    list: () => Effect.sync(() => Array.from(peers.values())),
    put: (peer) => Effect.sync(() => void peers.set(peer.environmentId, peer)),
    remove: (id) => Effect.sync(() => void peers.delete(id)),
  };
}
