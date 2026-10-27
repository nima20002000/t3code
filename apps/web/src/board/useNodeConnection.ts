import type { NodeLiveFacts } from "@t3tools/board-core/runView";
import { useAtomValue } from "@effect/atom-react";
import { environmentSummaries } from "./upstream";

const DOWN = new Set(["offline", "error", "unsupported"]);

/** Each environment's connection as the board shows it; anything short of down reads as reconnecting. */
export function useNodeConnections(): (environmentId: string) => NodeLiveFacts["connection"] {
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  return (environmentId) => {
    const phase = environments.find(
      (entry) => entry.environmentId === environmentId,
    )?.connectionState;
    if (phase === "connected") return "connected";
    return phase === undefined || DOWN.has(phase) ? "offline" : "reconnecting";
  };
}
