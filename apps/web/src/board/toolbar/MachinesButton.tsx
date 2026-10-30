import { checkPairingLink } from "@t3tools/board-core/pairingLink";
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
  const check = checkPairingLink(link);
  const isLink = check.kind === "link";
  const ready = link.trim() !== "" && check.kind !== "problem" && (isLink || host.trim() !== "");
  const pair = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runBoardMutation((client) =>
        client.pairPeer({
          headers: {},
          payload: {
            ...(name.trim() ? { name: name.trim() } : {}),
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
        <p className="text-xs text-muted-foreground">
          On the new computer, open the app and choose “Add to a board” at the bottom left, then
          paste its link here.
        </p>
        <label className="grid gap-1">
          Link from the new computer
          <Input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="http://…/pair#token=…"
          />
        </label>
        {check.kind === "problem" && link.trim() ? (
          <p className="text-xs text-destructive">{check.message}</p>
        ) : check.kind === "link" && check.warning ? (
          <p className="text-xs text-warning">{check.warning}</p>
        ) : null}
        <label className="grid gap-1">
          Name (optional)
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Uses the computer's own name"
          />
        </label>
        {check.kind === "code" && link.trim() ? (
          <label className="grid gap-1">
            Machine address
            <Input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="https://machine.example.com"
            />
          </label>
        ) : null}
        <Button size="sm" disabled={busy || !ready} onClick={() => void pair()}>
          {busy ? "Adding…" : "Add computer"}
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
