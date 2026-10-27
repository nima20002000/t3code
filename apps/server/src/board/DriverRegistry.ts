import { NodeDriverError, type NodeDriver } from "@t3tools/board-core";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as LocalDriver from "./LocalDriver.ts";
import * as BoardStore from "./BoardStore.ts";
import * as PeerStore from "./remote/PeerStore.ts";
import * as RemoteDriver from "./remote/RemoteDriver.ts";
import { ServerEnvironment } from "./upstream.ts";

export class DriverRegistry extends Context.Service<
  DriverRegistry,
  {
    readonly get: (environmentId: EnvironmentId) => Effect.Effect<NodeDriver, NodeDriverError>;
    readonly register: (environmentId: EnvironmentId, driver: NodeDriver) => Effect.Effect<void>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<void>;
  }
>()("t3/board/DriverRegistry") {}

const make = Effect.gen(function* () {
  const local = yield* LocalDriver.LocalDriver;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const localId = yield* environment.getEnvironmentId;
  const boardStore = yield* BoardStore.BoardStore;
  const remote = RemoteDriver.make(PeerStore.makeBoard(boardStore));
  const peers = yield* boardStore.listPairedPeers();
  const drivers = yield* Ref.make<ReadonlyMap<EnvironmentId, NodeDriver>>(
    new Map([
      ...peers
        .filter((peer) => peer.environmentId !== localId)
        .map((peer) => [peer.environmentId, remote] as const),
      [localId, local],
    ]),
  );
  const get = Effect.fn("DriverRegistry.get")(function* (id: EnvironmentId) {
    const driver = (yield* Ref.get(drivers)).get(id);
    if (driver === undefined)
      return yield* new NodeDriverError({
        operation: "launch",
        message: `No board driver is registered for environment ${id}.`,
      });
    return driver;
  });
  const register = Effect.fn("DriverRegistry.register")((id: EnvironmentId, driver: NodeDriver) =>
    Ref.update(drivers, (current) => new Map(current).set(id, driver)),
  );
  const remove = Effect.fn("DriverRegistry.remove")((id: EnvironmentId) =>
    Ref.update(drivers, (current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    }),
  );
  return DriverRegistry.of({ get, register, remove });
});

export const layer = Layer.effect(DriverRegistry, make).pipe(Layer.provide(LocalDriver.layer));
