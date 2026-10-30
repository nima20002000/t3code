import { useAtomValue } from "@effect/atom-react";
import type { BoardPeer } from "@t3tools/board-core/http";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";

import { runBoardApi } from "./boardApi";
import { useBoardPeers } from "./boardStore";
import { connectPairing, environmentCatalog, toastManager, useAtomCommand } from "./upstream";

/** Paired machines this window has never saved, so it should connect to them. */
function machinesToConnect(
  peers: ReadonlyArray<BoardPeer>,
  saved: ReadonlyMap<string, unknown>,
  attempted: ReadonlySet<string>,
): ReadonlyArray<BoardPeer> {
  return peers.filter(
    (peer) => !saved.has(peer.environmentId) && !attempted.has(peer.environmentId),
  );
}

const RETRY_MS = 30_000;

/**
 * Connects this window to every machine the hub has paired, through t3's own saved connections,
 * with a one-time code the hub mints there. A machine the user removed is re-added on the next
 * visit; a disabled one stays saved and is left alone. Failures retry quietly after the first toast.
 */
export function useConnectBoardMachines() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const peers = useBoardPeers();
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const attempted = useRef(new Set<string>());
  const warned = useRef(new Set<string>());
  const [retries, setRetries] = useState(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pending retries stop when the board closes.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pairs this window with machines on another server as the hub reports them.
  useEffect(() => {
    if (!catalog.isReady) return;
    for (const id of attempted.current) {
      if (!peers.some((peer) => peer.environmentId === id)) attempted.current.delete(id);
    }
    for (const peer of machinesToConnect(peers, catalog.entries, attempted.current)) {
      attempted.current.add(peer.environmentId);
      void (async () => {
        try {
          const pairing = await runBoardApi((client) =>
            client.pairPeerWindow({ headers: {}, params: { peerId: peer.id } }),
          );
          if (pairing === null) return;
          const result = await connect({
            host: pairing.httpBaseUrl,
            pairingCode: pairing.pairingCode,
            expectedEnvironmentId: pairing.environmentId,
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        } catch (cause) {
          const timer = setTimeout(() => {
            timers.current.delete(timer);
            attempted.current.delete(peer.environmentId);
            setRetries((count) => count + 1);
          }, RETRY_MS);
          timers.current.add(timer);
          // A machine the hub already reports as down needs no second warning.
          if (peer.status !== "connected" || warned.current.has(peer.environmentId)) return;
          warned.current.add(peer.environmentId);
          toastManager.add({
            type: "error",
            title: `Could not open ${peer.name} in this window`,
            description: `${cause instanceof Error ? cause.message : String(cause)} Connect it in Settings → Connections.`,
          });
        }
      })();
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `retries` reruns this pass once a failed machine's back-off ends.
  }, [catalog, peers, connect, retries]);
}
