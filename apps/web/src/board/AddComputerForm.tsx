import type { BoardPeer } from "@t3tools/board-core/http";
import { checkPairingLink } from "@t3tools/board-core/pairingLink";
import { useState, type KeyboardEvent } from "react";

import { runBoardMutation } from "./boardApi";
import { Button, Input } from "./upstream";

const INSTALL_COMMAND =
  "curl -fsSL https://github.com/nima20002000/t3code/releases/latest/download/install.sh | sh";

/** Pairs the hub with a new computer from its one-time link. Not a <form>, so it can sit inside one. */
export function AddComputerForm(props: { readonly onAdded?: (peer: BoardPeer) => void }) {
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
      const peer = await runBoardMutation((client) =>
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
      props.onAdded?.(peer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  // Enter pairs instead of submitting a surrounding form.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void pair();
  };
  return (
    <div className="grid gap-2">
      <div className="grid gap-1 text-xs text-muted-foreground">
        <p>
          Get a link on the new computer: open the app and choose “Add to a board” at the bottom
          left, or on a Linux server run
        </p>
        <code className="rounded bg-muted px-1.5 py-1 font-mono break-all text-foreground select-all">
          {INSTALL_COMMAND}
        </code>
      </div>
      <label className="grid gap-1">
        Link from the new computer
        <Input
          value={link}
          onChange={(event) => setLink(event.target.value)}
          onKeyDown={onKeyDown}
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
          onKeyDown={onKeyDown}
          placeholder="Uses the computer's own name"
        />
      </label>
      {check.kind === "code" && link.trim() ? (
        <label className="grid gap-1">
          Machine address
          <Input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="https://machine.example.com"
          />
        </label>
      ) : null}
      <Button type="button" size="sm" disabled={busy || !ready} onClick={() => void pair()}>
        {busy ? "Adding…" : "Add computer"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
