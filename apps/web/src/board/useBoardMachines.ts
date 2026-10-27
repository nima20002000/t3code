import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useBoardPeers } from "./boardStore";

export function useBoardMachines() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const primaryId = primaryEnvironmentId ?? connectedIds[0] ?? null;
  const identities = useEnvironmentIdentities();
  const peers = useBoardPeers();
  const primary = primaryId
    ? [
        {
          environmentId: primaryId,
          label: identities.find((item) => item.environmentId === primaryId)?.label ?? "Hub",
        },
      ]
    : [];
  return [
    ...primary,
    ...peers
      .filter((peer) => peer.environmentId !== primaryId)
      .map((peer) => ({ environmentId: peer.environmentId, label: peer.name })),
  ];
}
