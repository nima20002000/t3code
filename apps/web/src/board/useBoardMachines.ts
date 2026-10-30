import { useBoardPeers } from "./boardStore";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "./upstream";

/** The hub, its paired machines, and machines this app is connected to that the hub has not paired yet. */
export function useBoardMachines() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const primaryId = primaryEnvironmentId ?? connectedIds[0] ?? null;
  const identities = useEnvironmentIdentities();
  const peers = useBoardPeers();
  const labelOf = (environmentId: string) =>
    identities.find((item) => item.environmentId === environmentId)?.label;
  const primary = primaryId
    ? [{ environmentId: primaryId, label: labelOf(primaryId) ?? "Hub", paired: true }]
    : [];
  const paired = peers
    .filter((peer) => peer.environmentId !== primaryId)
    .map((peer) => ({ environmentId: peer.environmentId, label: peer.name, paired: true }));
  const unpaired = connectedIds
    .filter(
      (environmentId) =>
        environmentId !== primaryId && !peers.some((peer) => peer.environmentId === environmentId),
    )
    .map((environmentId) => ({
      environmentId,
      label: labelOf(environmentId) ?? environmentId,
      paired: false,
    }));
  return [...primary, ...paired, ...unpaired];
}
