/** What a pasted "Add a computer" value is: a pairing link, a bare code that still needs an address, or a mistake. */
export type PairingLinkCheck =
  | {
      readonly kind: "link";
      readonly url: string;
      readonly host: string;
      /** Set for a link naming the hub's own machine: right for a second server there, wrong otherwise. */
      readonly warning?: string;
    }
  | { readonly kind: "code" }
  | { readonly kind: "problem"; readonly message: string };

const SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const APP_LINK = /^t3code(?:-[a-z]+)?:$/;
const SERVER_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

// A link naming the computer itself only reaches the computer it was copied from.
const isLoopbackHost = (hostname: string) => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "::" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
};

const tokenOf = (url: URL) => {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  return hash.get("token")?.trim() || url.searchParams.get("token")?.trim() || "";
};

export function checkPairingLink(text: string): PairingLinkCheck {
  let value = text.trim();
  if (!SCHEME.test(value)) return { kind: "code" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "problem", message: "This is not a valid link." };
  }
  // The app's own QR codes wrap the server link as t3code://pair?pairingUrl=<link>.
  if (APP_LINK.test(url.protocol)) {
    const inner = url.host === "pair" ? url.searchParams.get("pairingUrl")?.trim() : undefined;
    if (!inner || !URL.canParse(inner))
      return { kind: "problem", message: "This app link has no pairing link inside it." };
    value = inner;
    url = new URL(inner);
  }
  if (!SERVER_PROTOCOLS.has(url.protocol))
    return { kind: "problem", message: "A pairing link starts with http:// or https://." };
  // Hosted links (app.t3.codes/pair?host=…) carry the computer's address as a parameter.
  const hosted = url.searchParams.get("host")?.trim();
  let host = url.hostname;
  if (hosted) {
    if (!URL.canParse(SCHEME.test(hosted) ? hosted : `https://${hosted}`))
      return { kind: "problem", message: "This link names an invalid computer address." };
    host = new URL(SCHEME.test(hosted) ? hosted : `https://${hosted}`).hostname;
  }
  if (!tokenOf(url))
    return {
      kind: "problem",
      message: "This link has no pairing token. Copy the whole link, including the part after #.",
    };
  if (isLoopbackHost(host))
    return {
      kind: "link",
      url: value,
      host,
      warning:
        "This link only works on the computer it came from. If it came from another computer, open the app there, choose “Add to a board”, let other computers reach it, and copy the new link.",
    };
  return { kind: "link", url: value, host };
}
