import * as NodeEvents from "node:events";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { chromium, type Browser, type BrowserContext, type BrowserType } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type BrowserLaunchConfig, ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  return {
    contexts,
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
};

const HEADLESS: BrowserLaunchConfig = {
  mode: "headless",
  executablePath: "/test/chromium",
  proxy: "",
};

const options = () => ({
  profilesDir: "/test/profiles",
  launchConfig: vi.fn(async (): Promise<BrowserLaunchConfig> => HEADLESS),
  env: {},
});

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockReset();
  launches.rm.mockResolvedValue(undefined);
});

describe("ServerBrowserContexts", () => {
  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.launchConfig).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledTimes(1);
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.contexts) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium" }),
    );
    expect(launches.mkdir).toHaveBeenCalledWith("/test/profiles/work%2Fteam", { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementation(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    // Each mode keeps its own copy of the profile; clearing removes both.
    expect(launches.rm.mock.calls).toEqual([
      ["/test/profiles/work%2Fteam", { recursive: true, force: true }],
      ["/test/profiles-headed/work%2Fteam", { recursive: true, force: true }],
    ]);
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.contexts[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenCalledWith("/test/profiles/never-opened", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementation(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.launchConfig.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return HEADLESS;
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { T3CODE_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.contexts[0]?.close).toHaveBeenCalled();
  });

  it("launches a visible Chrome on the configured display, through the proxy, with its own profiles", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { PATH: "/usr/bin" },
      launchConfig: async () => ({
        mode: "headed",
        executablePath: "/opt/google/chrome/chrome",
        proxy: "http://agent:s%40cret@127.0.0.1:3128",
        display: ":99",
      }),
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    await pool.contextFor("work");
    const shared = launches.launch.mock.calls[0]?.[0];
    expect(shared).toMatchObject({
      executablePath: "/opt/google/chrome/chrome",
      headless: false,
      env: { PATH: "/usr/bin", DISPLAY: ":99" },
      proxy: { server: "http://127.0.0.1:3128", username: "agent", password: "s@cret" },
    });
    expect(shared?.args).not.toContain("--force-device-scale-factor=2");
    expect(launches.persistent).toHaveBeenCalledWith(
      "/test/profiles-headed/work",
      expect.objectContaining({
        headless: false,
        proxy: { server: "http://127.0.0.1:3128", username: "agent", password: "s@cret" },
      }),
    );
    await pool.close();
  });

  it("keeps headless as before and sends no proxy when none is set", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({ ...options(), env: { DISPLAY: ":0" } });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    const launched = launches.launch.mock.calls[0]?.[0];
    expect(launched).toMatchObject({ headless: true, env: { DISPLAY: ":0" } });
    expect(launched?.args).toContain("--force-device-scale-factor=2");
    expect(launched).not.toHaveProperty("proxy");
    await pool.close();
  });

  it("refuses a proxy that is not an http or socks URL instead of browsing without it", async () => {
    const pool = new ServerBrowserContexts({
      ...options(),
      launchConfig: async () => ({ ...HEADLESS, proxy: "ftp://127.0.0.1:21" }),
    });
    await expect(pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
      "must be an http, https or socks URL",
    );
    expect(launches.launch).not.toHaveBeenCalled();
    await pool.close();
  });

  it("relaunches with the new settings, holding requests until the old browser has closed", async () => {
    const first = makeBrowser();
    const second = makeBrowser();
    const human = makeContext();
    launches.launch
      .mockResolvedValueOnce(first as unknown as Browser)
      .mockResolvedValueOnce(second as unknown as Browser);
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    let config: BrowserLaunchConfig = HEADLESS;
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({
      ...options(),
      launchConfig: async () => config,
      onContextClose,
    });
    const agent = await pool.contextFor("default", "agent");
    const persistent = await pool.contextFor("work");
    config = {
      mode: "headed",
      executablePath: "/opt/google/chrome/chrome",
      proxy: "",
      display: ":1",
    };
    const relaunching = pool.relaunch();
    const reopened = pool.contextFor("default", "agent");
    await relaunching;
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(human.close).toHaveBeenCalledTimes(1);
    expect(onContextClose).toHaveBeenCalledWith(agent);
    expect(onContextClose).toHaveBeenCalledWith(persistent);
    expect(await reopened).not.toBe(agent);
    expect(launches.launch).toHaveBeenLastCalledWith(expect.objectContaining({ headless: false }));
    await pool.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("starts one Xvfb for headed mode without a display and stops it when the browser relaunches", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const stop = vi.fn();
    const startDisplay = vi.fn(async () => ({ display: ":42", stop }));
    const pool = new ServerBrowserContexts({
      ...options(),
      startDisplay,
      launchConfig: async () => ({
        mode: "headed",
        executablePath: "/usr/bin/chromium",
        proxy: "",
        display: "xvfb",
      }),
    });
    await Promise.all([pool.contextFor("default", "a"), pool.contextFor("default", "b")]);
    expect(startDisplay).toHaveBeenCalledTimes(1);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ env: expect.objectContaining({ DISPLAY: ":42" }) }),
    );
    await pool.relaunch();
    expect(stop).toHaveBeenCalledTimes(1);
    await pool.close();
  });
});
