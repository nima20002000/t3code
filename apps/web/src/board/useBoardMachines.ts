import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import { useBoardPeers } from "./boardStore";

export function useBoardMachines() {
  const primaryId = usePrimaryEnvironmentId();
  const identities = useEnvironmentIdentities();
  const peers = useBoardPeers();
  const primary = primaryId
    ? [
        {
          environmentId: primaryId,
          label:
            identities.find((item) => item.environmentId === primaryId)?.label ?? "Hub",
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
