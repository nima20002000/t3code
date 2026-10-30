import { MonitorIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { AddComputerForm } from "../AddComputerForm";
import { runBoardMutation } from "../boardApi";
import { useBoardPeers } from "../boardStore";
import { ToolbarPopover } from "./ToolbarPopover";
import { Button, usePrimaryEnvironment } from "../upstream";

export function MachinesButton() {
  const peers = useBoardPeers();
  const primary = usePrimaryEnvironment();
  const [error, setError] = useState<string | null>(null);
  const remove = async (id: string) => {
    setError(null);
    try {
      await runBoardMutation((client) =>
        client.deletePeer({ headers: {}, params: { peerId: id } }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <ToolbarPopover label="Machines" icon={<MonitorIcon />}>
      <div className="grid gap-2">
        <p className="text-xs text-muted-foreground">
          Computers the board's agents can work on. This window connects to them by itself.
        </p>
        <div>
          {primary?.label ?? "Hub"} <span className="text-muted-foreground">· hub</span>
        </div>
        {peers.map((peer) => (
          <div key={peer.id} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate">{peer.name}</div>
              <div className="text-xs text-muted-foreground">
                {peer.status}
                {peer.error ? ` · ${peer.error}` : ""}
              </div>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove machine ${peer.name}`}
              onClick={() => void remove(peer.id)}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <h3 className="mt-2 font-medium">Add a computer</h3>
        <AddComputerForm />
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </ToolbarPopover>
  );
}
