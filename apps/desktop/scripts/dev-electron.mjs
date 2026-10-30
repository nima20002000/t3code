import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  desktopDir,
  resolveDevProtocolClient,
  resolveElectronLaunchCommand,
} from "./electron-launcher.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/electron/WindowsForegroundFocusWorker.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/snapShot/GlobalShiftShortcutWorker.cjs",
  "dist-electron/snapShot/RegionSnapShotWorker.cjs",
  "dist-electron/snapShot/SnapShotAccessibilityWorker.cjs",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  {
    directory: "dist-electron/electron",
    files: new Set(["WindowsForegroundFocusWorker.cjs"]),
  },
  {
    directory: "dist-electron/snapShot",
    files: new Set([
      "GlobalShiftShortcutWorker.cjs",
      "RegionSnapShotWorker.cjs",
      "SnapShotAccessibilityWorker.cjs",
    ]),
  },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const remoteDebuggingPort = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();
// An amdgpu VM fault right after a relaunch took down the whole desktop; dev runs without GPU unless T3CODE_DESKTOP_GPU=1.
const disableGpu = hostPlatform === "linux" && process.env.T3CODE_DESKTOP_GPU !== "1";
const devLogDir = NodePath.resolve(desktopDir, "..", "..", ".t3", "logs");
const devLogPath = NodePath.join(devLogDir, "dev-electron.log");
const keptChromiumLogs = 20;

// Sync appends so the last lines survive a crash that takes the terminal with it.
function devLog(message) {
  try {
    NodeFS.mkdirSync(devLogDir, { recursive: true });
    NodeFS.appendFileSync(devLogPath, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {}
}

function gpuSnapshot() {
  if (hostPlatform !== "linux") return "";
  const read = (path) => {
    try {
      return NodeFS.readFileSync(path, "utf8").trim();
    } catch {
      return "?";
    }
  };
  let cards = [];
  try {
    cards = NodeFS.readdirSync("/sys/class/drm").filter((name) => /^card\d+$/.test(name));
  } catch {}
  return cards
    .map((card) => {
      const device = `/sys/class/drm/${card}/device`;
      let temp = "?";
      try {
        const hwmon = NodeFS.readdirSync(`${device}/hwmon`)[0];
        if (hwmon) temp = `${Number(read(`${device}/hwmon/${hwmon}/temp1_input`)) / 1000}C`;
      } catch {}
      const vram = Math.round(Number(read(`${device}/mem_info_vram_used`)) / 1048576);
      return `${card} busy=${read(`${device}/gpu_busy_percent`)}% vram=${vram}MiB temp=${temp}`;
    })
    .join("; ");
}

function chromiumLogArgs() {
  try {
    NodeFS.mkdirSync(devLogDir, { recursive: true });
    const old = NodeFS.readdirSync(devLogDir)
      .filter((name) => name.startsWith("electron-") && name.endsWith(".log"))
      .toSorted();
    for (const name of old.slice(0, Math.max(0, old.length - keptChromiumLogs + 1))) {
      NodeFS.rmSync(NodePath.join(devLogDir, name), { force: true });
    }
  } catch {}
  const file = NodePath.join(
    devLogDir,
    `electron-${new Date().toISOString().replaceAll(":", "-")}.log`,
  );
  return [`--enable-logging=file`, `--log-file=${file}`];
}

NodeChildProcess.execFileSync(
  process.execPath,
  [NodePath.join(desktopDir, "scripts/build-browser-secret.mjs")],
  { stdio: "inherit" },
);

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpHost: devServer.hostname,
  tcpPort: port,
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const devProtocolClient = resolveDevProtocolClient();
if (devProtocolClient) {
  childEnv.T3CODE_DESKTOP_APP_USER_MODEL_ID = devProtocolClient.appBundleId;
  childEnv.T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED = "1";
}

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];

function killChildTreeByPid(pid, signal) {
  if (hostPlatform === "win32" || typeof pid !== "number") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function cleanupStaleDevApps() {
  if (hostPlatform === "win32") {
    return;
  }

  const escapedDesktopDir = desktopDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  NodeChildProcess.spawnSync(
    "pkill",
    ["-f", "--", `(^| )--t3code-dev-root=${escapedDesktopDir}( |$)`],
    {
      stdio: "ignore",
    },
  );
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const electronArgs = [
    ...(remoteDebuggingPort ? [`--remote-debugging-port=${remoteDebuggingPort}`] : []),
    ...(disableGpu ? ["--disable-gpu"] : []),
    ...chromiumLogArgs(),
  ];
  const launchArgs = devProtocolClient
    ? electronArgs
    : [...electronArgs, `--t3code-dev-root=${desktopDir}`, "dist-electron/main.cjs"];
  const electronCommand = resolveElectronLaunchCommand(launchArgs);
  const app = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
  });

  currentApp = app;
  const startedAt = Date.now();
  devLog(`app started pid=${app.pid} args=${electronCommand.args.join(" ")} gpu=${gpuSnapshot()}`);

  app.once("error", (error) => {
    devLog(`app pid=${app.pid} failed to spawn: ${error.message}`);
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      scheduleRestart("app failed to spawn");
    }
  });

  app.once("exit", (code, signal) => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const expected = expectedExits.has(app) ? "expected" : "unexpected";
    devLog(
      `app pid=${app.pid} exited code=${code} signal=${signal} after ${seconds}s (${expected}) gpu=${gpuSnapshot()}`,
    );
    if (currentApp === app) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
      scheduleRestart(`app exited abnormally (code=${code} signal=${signal})`);
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    app.kill("SIGTERM");
    killChildTreeByPid(app.pid, "TERM");
    cleanupStaleDevApps();

    setTimeout(() => {
      if (settled) {
        return;
      }

      devLog(
        `app pid=${app.pid} ignored SIGTERM for ${forcedShutdownTimeoutMs}ms; sending SIGKILL`,
      );
      app.kill("SIGKILL");
      killChildTreeByPid(app.pid, "KILL");
      cleanupStaleDevApps();
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart(reason) {
  devLog(`restart requested: ${reason}`);
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = NodeFS.watch(
      NodePath.join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        scheduleRestart(`${directory}/${filename} changed`);
      },
    );

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (hostPlatform === "win32") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], {
    stdio: "ignore",
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  devLog(`launcher shutting down (exit ${exitCode})`);

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

devLog(`launcher started gpu=${disableGpu ? "disabled" : "enabled"}`);
startWatchers();
cleanupStaleDevApps();
startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
