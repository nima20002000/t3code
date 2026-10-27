import { MonitorIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { runBoardMutation } from "../boardApi";
import { useBoardPeers } from "../boardStore";
import { ToolbarPopover } from "./ToolbarPopover";
import { Button, Input, usePrimaryEnvironment } from "../upstream";

export function MachinesButton() {
  const peers = useBoardPeers();
  const primary = usePrimaryEnvironment();
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLink = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(link.trim());
  const pair = async () => {
    if (!name.trim() || !link.trim() || (!isLink && !host.trim()) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runBoardMutation((client) =>
        client.pairPeer({
          headers: {},
          payload: {
            name: name.trim(),
            pairingUrlOrCode: link.trim(),
            ...(!isLink ? { host: host.trim() } : {}),
          },
        }),
      );
      setName("");
      setLink("");
      setHost("");
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
        <p className="text-xs text-muted-foreground">
          Pair machines here for the hub. Connect them in Settings → Connections to use their chats.
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
        <label className="grid gap-1">
          Name
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Machine name"
          />
        </label>
        <label className="grid gap-1">
          Pairing link or code
          <Input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="Paste pairing link or code"
          />
        </label>
        {link.trim() && !isLink ? (
          <label className="grid gap-1">
            Machine address
            <Input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="https://machine.example.com"
            />
          </label>
        ) : null}
        <Button
          size="sm"
          disabled={busy || !name.trim() || !link.trim() || (!isLink && !host.trim())}
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
