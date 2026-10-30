import { describe, expect, it } from "vite-plus/test";
import { checkPairingLink } from "./pairingLink.ts";

describe("checkPairingLink", () => {
  it("accepts a computer's pairing link on its LAN or Tailscale address", () => {
    expect(checkPairingLink("  http://192.168.1.20:3773/pair#token=abc  ")).toEqual({
      kind: "link",
      url: "http://192.168.1.20:3773/pair#token=abc",
      host: "192.168.1.20",
    });
    expect(checkPairingLink("http://100.101.102.103:3773/pair?token=abc")).toMatchObject({
      kind: "link",
      host: "100.101.102.103",
    });
  });

  it("unwraps the app link a pairing QR code carries", () => {
    const inner = "http://10.0.0.5:3773/pair#token=xyz";
    expect(checkPairingLink(`t3code://pair?pairingUrl=${encodeURIComponent(inner)}`)).toMatchObject(
      { kind: "link", url: inner, host: "10.0.0.5" },
    );
  });

  it("reads the computer address from a hosted pairing link", () => {
    expect(
      checkPairingLink("https://app.t3.codes/pair?host=https%3A%2F%2Fbox.ts.net#token=abc"),
    ).toMatchObject({ kind: "link", host: "box.ts.net" });
  });

  it("treats text without a scheme as a pairing code that needs an address", () => {
    expect(checkPairingLink("ABCD-1234")).toEqual({ kind: "code" });
  });

  it.each([
    ["http://localhost:3773/pair#token=abc"],
    ["http://127.0.0.1:3773/pair#token=abc"],
    ["http://[::1]:3773/pair#token=abc"],
    ["http://0.0.0.0:3773/pair#token=abc"],
    ["https://app.t3.codes/pair?host=http%3A%2F%2Flocalhost%3A3773#token=abc"],
  ])("warns that %s only reaches the computer it came from", (link) => {
    expect(checkPairingLink(link)).toMatchObject({
      kind: "link",
      warning: expect.stringContaining("only works on the computer it came from"),
    });
  });

  it.each([
    ["http://192.168.1.20:3773/pair", "no pairing token"],
    ["ftp://192.168.1.20/pair#token=abc", "starts with http"],
    ["t3code://pair?other=1", "no pairing link inside"],
    ["http://exa mple.com/pair#token=a", "not a valid link"],
  ])("explains what is wrong with %s", (link, problem) => {
    expect(checkPairingLink(link)).toMatchObject({
      kind: "problem",
      message: expect.stringContaining(problem),
    });
  });
});
