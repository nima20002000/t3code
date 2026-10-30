import { AuthStandardClientScopes, type AdvertisedEndpoint } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { BoardTailscaleStatus } from "@t3tools/board-core/http";
import { runBoardApi } from "./boardApi";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  QRCodeSvg,
  createServerPairingCredential,
  desktopNetworkAccessStateAtom,
  isQrShareableEndpoint,
  refreshDesktopNetworkAccessState,
  resolveDesktopPairingUrl,
  useEnvironmentQuery,
} from "./upstream";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const REOPEN_KEY = "board:join-board-open";

/** Turning on network access restarts the app; the dialog comes back by itself afterwards. */
export function takeJoinBoardReopen() {
  try {
    const reopen = localStorage.getItem(REOPEN_KEY) === "1";
    localStorage.removeItem(REOPEN_KEY);
    return reopen;
  } catch {
    return false;
  }
}

/** A computer's addresses other computers can dial, Tailscale first since it works from anywhere. */
function reachableAddresses(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  tailscaleIpv4: string | null,
) {
  const shareable = endpoints.filter(isQrShareableEndpoint).map((endpoint) => ({
    url: endpoint.httpBaseUrl,
    label: endpoint.label,
    tailnet: endpoint.reachability === "private-network",
  }));
  // The app notices a fresh Tailscale join only on its next probe; offer the address right away.
  const port = shareable.map((item) => new URL(item.url).port).find(Boolean);
  if (
    tailscaleIpv4 &&
    port &&
    !shareable.some((item) => new URL(item.url).hostname === tailscaleIpv4)
  ) {
    shareable.push({ url: `http://${tailscaleIpv4}:${port}`, label: "Tailscale", tailnet: true });
  }
  return shareable.toSorted((a, b) => Number(b.tailnet) - Number(a.tailnet));
}

/** The new computer's side of joining a board: be reachable, optionally join Tailscale, hand out a link. */
export function JoinBoardDialog(props: { readonly onClose: () => void }) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const network = useEnvironmentQuery(bridge ? desktopNetworkAccessStateAtom : null);
  const [tailscale, setTailscale] = useState<BoardTailscaleStatus | null>(null);
  const [authKey, setAuthKey] = useState("");
  const [busy, setBusy] = useState<"reach" | "tailscale" | "link" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [switchTailnet, setSwitchTailnet] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this computer's Tailscale state from its server once when the dialog opens
  useEffect(() => {
    const controller = new AbortController();
    runBoardApi((client) => client.getTailscale({ headers: {} }), controller.signal).then(
      setTailscale,
      () => setTailscale({ installed: false, ipv4: null, tailnet: null }),
    );
    return () => controller.abort();
  }, []);

  const reachable = network.data?.serverExposureState.mode === "network-accessible";
  const addresses = reachable
    ? reachableAddresses(network.data?.advertisedEndpoints ?? [], tailscale?.ipv4 ?? null)
    : [];
  const chosen = addresses.find((item) => item.url === address) ?? addresses[0] ?? null;

  const run = async (kind: "reach" | "tailscale" | "link", action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  const makeReachable = () =>
    run("reach", async () => {
      try {
        localStorage.setItem(REOPEN_KEY, "1");
      } catch {}
      await bridge?.setServerExposureMode("network-accessible").catch((cause: unknown) => {
        takeJoinBoardReopen();
        throw cause;
      });
      refreshDesktopNetworkAccessState();
    });
  const joinTailscale = () =>
    run("tailscale", async () => {
      const next = await runBoardApi((client) =>
        client.joinTailscale({ headers: {}, payload: { authKey: authKey.trim() } }),
      );
      setTailscale(next);
      setSwitchTailnet(false);
      setAuthKey("");
      setLink(null);
      refreshDesktopNetworkAccessState();
    });
  const createLink = () =>
    run("link", async () => {
      if (!chosen) return;
      const created = await createServerPairingCredential({
        label: "Board hub",
        // The full client grant, so the hub can also connect its own windows here.
        scopes: AuthStandardClientScopes,
      });
      setLink({
        url: resolveDesktopPairingUrl(chosen.url, created.credential),
        expiresAt: new Date(DateTime.toEpochMillis(created.expiresAt)).toLocaleTimeString(),
      });
      setCopied(false);
    });
  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setCopied(true);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add this computer to a board</DialogTitle>
          <DialogDescription>
            Make a one-time link here, then paste it into the board's Machines → Add a computer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-5">
            <section className="grid gap-2">
              <h3 className="text-sm font-medium">1. Let the board reach this computer</h3>
              {reachable ? (
                <p className="text-sm text-muted-foreground">
                  Other computers can reach this one
                  {addresses.length ? ` at ${addresses.map((item) => item.url).join(", ")}` : ""}.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-muted-foreground">
                    Right now only this computer can use its app. Turning this on restarts the app
                    once and opens this window again.
                  </p>
                  <Button
                    size="sm"
                    disabled={busy !== null || !network.data}
                    onClick={() => void makeReachable()}
                  >
                    {busy === "reach" ? "Turning on…" : "Let other computers reach it"}
                  </Button>
                </div>
              )}
            </section>
            <section className="grid gap-2">
              <h3 className="text-sm font-medium">2. On a different network? Join Tailscale</h3>
              {tailscale?.ipv4 && !switchTailnet ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-muted-foreground">
                    On Tailscale as {tailscale.ipv4}
                    {tailscale.tailnet ? ` (network ${tailscale.tailnet})` : ""}.
                  </p>
                  <Button size="xs" variant="outline" onClick={() => setSwitchTailnet(true)}>
                    Join another network
                  </Button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Skip this when both computers are on the same network. Otherwise paste the join
                    key the board's owner gave you; your computer asks for its password once
                    {tailscale?.installed === false ? " and installs Tailscale" : ""}.
                  </p>
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (authKey.trim() && busy === null) void joinTailscale();
                    }}
                  >
                    <Input
                      aria-label="Tailscale join key"
                      type="password"
                      placeholder="tskey-auth-…"
                      value={authKey}
                      onChange={(event) => setAuthKey(event.target.value)}
                    />
                    <Button type="submit" size="sm" disabled={!authKey.trim() || busy !== null}>
                      {busy === "tailscale" ? "Joining…" : "Join"}
                    </Button>
                  </form>
                </>
              )}
            </section>
            <section className="grid gap-2">
              <h3 className="text-sm font-medium">3. Make the link</h3>
              {addresses.length > 1 ? (
                <label className="grid gap-1 text-sm">
                  Address the board uses
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    value={chosen?.url ?? ""}
                    onChange={(event) => {
                      setAddress(event.target.value);
                      setLink(null);
                    }}
                  >
                    {addresses.map((item) => (
                      <option key={item.url} value={item.url}>
                        {item.url} ({item.label})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div>
                <Button
                  size="sm"
                  disabled={!chosen || busy !== null}
                  onClick={() => void createLink()}
                >
                  {busy === "link" ? "Creating…" : link ? "Make a new link" : "Make link"}
                </Button>
              </div>
              {link ? (
                <div className="grid gap-2">
                  <div className="flex gap-2">
                    <Input aria-label="Pairing link" readOnly value={link.url} />
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label="Copy link"
                      onClick={() => void copy()}
                    >
                      {copied ? <CheckIcon /> : <CopyIcon />}
                    </Button>
                  </div>
                  <div className="flex items-center gap-3">
                    <QRCodeSvg
                      value={link.url}
                      size={160}
                      marginSize={2}
                      title="Pairing link QR code"
                    />
                    <p className="text-xs text-muted-foreground">
                      Works once, until {link.expiresAt}. Send it to the board's owner, or scan it
                      with a phone and pass it on.
                    </p>
                  </div>
                </div>
              ) : null}
            </section>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
