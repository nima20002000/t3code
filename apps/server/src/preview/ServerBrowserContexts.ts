// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID, type ServerBrowserMode } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

/** How this server launches its browser, read from its settings on every launch. */
export interface BrowserLaunchConfig {
  readonly mode: ServerBrowserMode;
  readonly executablePath: string;
  /** Proxy URL for the browser only; empty for none. */
  readonly proxy: string;
  /** Headed on Linux: the X display to show on, or "xvfb" to start one. */
  readonly display?: string | undefined;
}

interface StartedDisplay {
  readonly display: string;
  readonly stop: () => void;
}

interface Options {
  readonly profilesDir: string;
  readonly launchConfig: () => Promise<BrowserLaunchConfig>;
  readonly diagnose?: (config: BrowserLaunchConfig, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
  readonly startDisplay?: () => Promise<StartedDisplay>;
}

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks4:", "socks5:"]);

/**
 * Playwright's proxy option for a URL such as `http://127.0.0.1:3128`; a bare host means http.
 * Settings reach every client, so credentials belong in a local forwarding proxy, not here.
 * Errors never repeat the value, which may hold them.
 */
const parseBrowserProxy = (raw: string) => {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  } catch {
    throw new Error("The browser proxy is not a valid URL.");
  }
  if (!PROXY_PROTOCOLS.has(url.protocol) || url.hostname === "") {
    throw new Error("The browser proxy must be an http, https or socks URL.");
  }
  if (url.username || url.password) {
    throw new Error(
      "The browser proxy cannot hold a username or password. Run a local forwarding proxy that signs in upstream, and point the browser at it.",
    );
  }
  return { server: `${url.protocol}//${url.host}` };
};

/**
 * Headless renders at a real 2x so screencasts stay sharp; headed keeps 1x so its window fits a
 * normal display. The proxy reaches only this browser, never agents, git or terminals.
 */
const browserLaunchOptions = (
  config: BrowserLaunchConfig & { readonly display?: string | undefined },
  env: NodeJS.ProcessEnv,
) => {
  const headed = config.mode === "headed";
  const proxy = parseBrowserProxy(config.proxy);
  return {
    executablePath: config.executablePath,
    env: headed && config.display ? { ...env, DISPLAY: config.display } : env,
    args: [
      "--disable-gpu",
      ...(headed ? [] : ["--force-device-scale-factor=2"]),
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    headless: !headed,
    // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
    chromiumSandbox: !sandboxDisabled(env),
    ...(proxy ? { proxy } : {}),
  };
};

/** An Xvfb display for headed mode where no display runs; it prints its number once ready. */
const startXvfb = () =>
  new Promise<StartedDisplay>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "Xvfb",
      ["-displayfd", "1", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const number = /^(\d+)\n/.exec(output)?.[1];
      if (number !== undefined) resolve({ display: `:${number}`, stop: () => child.kill() });
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Xvfb exited with ${code} before it started.`)));
  });

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private display: Promise<StartedDisplay> | undefined;
  private relaunching: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const config = await this.options.launchConfig();
    const display =
      config.display === "xvfb" ? (await this.startedDisplay()).display : config.display;
    return {
      config,
      options: browserLaunchOptions({ ...config, display }, this.options.env ?? process.env),
    };
  }

  private startedDisplay() {
    if (!this.display) {
      const started = (this.options.startDisplay ?? startXvfb)().then(async (display) => {
        // A shutdown that began before this display existed cannot stop it.
        if (this.closing) {
          display.stop();
          throw new Error("The preview browser is closed.");
        }
        return display;
      });
      this.display = started;
      void started.catch(() => {
        if (this.display === started) this.display = undefined;
      });
    }
    return this.display;
  }

  private async launch<A>(config: BrowserLaunchConfig, start: () => Promise<A>) {
    try {
      return await start();
    } catch (cause) {
      throw (await this.options.diagnose?.(config, cause)) ?? cause;
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async ({ config, options }) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(config, () => chromium.launch(options));
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = Promise.all([
      this.clearing.get(key)?.catch(constVoid),
      this.relaunching?.catch(constVoid),
    ]);
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        // A persistent profile opens with a window; headed Chrome quits once its last one closes.
        const initialPages = context.pages();
        if (initialPages.length > 0) {
          context.once("page", () => {
            for (const page of initialPages) void page.close().catch(constVoid);
          });
        }
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const { config, options } = await this.launchOptions();
    const directory = this.profileDirectory(profileId, config.mode);
    const { chromium } = loadPlaywright();
    await NodeFSP.mkdir(directory, { recursive: true });
    return this.launch(config, () =>
      chromium.launchPersistentContext(directory, { ...options, ...contextOptions }),
    );
  }

  /** Each mode keeps its own profiles: Chrome and the headless shell differ in version. */
  private profileDirectory(profileId: string, mode: ServerBrowserMode) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      mode === "headed" ? `${this.options.profilesDir}-headed` : this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    await this.relaunching?.catch(constVoid);
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await (await this.sharedBrowser()).newContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const clearing = (async () => {
      // A relaunch owns the contexts it took until they close; their Chrome still uses the profile.
      if (this.relaunching) await this.relaunching.catch(constVoid);
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await Promise.all(
        (["headless", "headed"] as const).map((mode) =>
          NodeFSP.rm(this.profileDirectory(profileId, mode), { recursive: true, force: true }),
        ),
      );
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  /** Closes every context and the browser so the next one launches with the current settings. */
  relaunch() {
    if (this.closing) return this.closing;
    // Requests from now on wait for this relaunch instead of reusing what it closes.
    const contexts = this.takeContexts();
    const relaunching = (this.relaunching?.catch(constVoid) ?? Promise.resolve())
      .then(() => this.closeAll(contexts))
      .finally(() => {
        if (this.relaunching === relaunching) this.relaunching = undefined;
      });
    this.relaunching = relaunching;
    return relaunching;
  }

  close() {
    this.closing ??= this.closeAll(this.takeContexts());
    return this.closing;
  }

  private takeContexts() {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    return contexts;
  }

  /** New requests wait while this runs, so any browser or display left after the contexts is stale. */
  private async closeAll(contexts: ReadonlyArray<Promise<BrowserContext>>) {
    await Promise.allSettled(contexts.map(async (pending) => (await pending).close()));
    const browser = this.browser;
    this.browser = undefined;
    await (await browser?.catch(() => undefined))?.close().catch(constVoid);
    // Taken after the browser settles, since its launch may have started the display.
    const display = this.display;
    this.display = undefined;
    (await display?.catch(() => undefined))?.stop();
  }
}
