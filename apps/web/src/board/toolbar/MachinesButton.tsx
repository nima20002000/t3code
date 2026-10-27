import { MonitorIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { runBoardMutation } from "../boardApi";
import { useBoardPeers } from "../boardStore";
import { ToolbarPopover } from "./ToolbarPopover";

export function MachinesButton() {
  const peers = useBoardPeers();
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pair = async () => {
    if (!name.trim() || !link.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runBoardMutation((client) =>
        client.pairPeer({
          headers: {},
          payload: { name: name.trim(), pairingUrlOrCode: link.trim() },
        }),
      );
      setName("");
      setLink("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
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
        <div>
          This machine <span className="text-muted-foreground">· hub</span>
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
        <label className="grid gap-1">
          Name
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Machine name"
          />
        </label>
        <label className="grid gap-1">
          Pairing link
          <Input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="Paste pairing link"
          />
        </label>
        <Button
          size="sm"
          disabled={busy || !name.trim() || !link.trim()}
          onClick={() => void pair()}
        >
          {busy ? "Pairing…" : "Pair machine"}
        </Button>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </ToolbarPopover>
  );
}
