import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectServerUpdateTargets,
  type UpdateEverythingMachine,
} from "../components/sidebar/updateEverything.logic";
import { resolveVersionMismatch } from "../versionSkew";

const vps = (serverVersion: string): UpdateEverythingMachine => ({
  environmentId: EnvironmentId.make("vps"),
  label: "Italy VPS",
  serverConfig: {
    environment: {
      environmentId: EnvironmentId.make("vps"),
      label: "Italy VPS",
      platform: { os: "linux", arch: "x64" },
      serverVersion,
      capabilities: { repositoryIdentity: true, serverSelfUpdate: "boot-service" },
    },
    settings: { continueThreadsAfterServerUpdate: true },
  },
  connected: true,
  hostedByThisApp: false,
  canMaintain: true,
  updateState: { status: "idle" },
});

const targets = (serverVersion: string, appVersion: string) =>
  collectServerUpdateTargets([vps(serverVersion)], appVersion, false).targets.map(
    (target) => target.targetVersion,
  );

describe("Update everything on fork builds", () => {
  it("moves a connected server on an older fork build of the same base to this app's build", () => {
    expect(targets("0.1.5-board.3", "0.1.5-board.4")).toEqual(["0.1.5-board.4"]);
    expect(targets("0.1.5-board.9", "0.1.6-board.1")).toEqual(["0.1.6-board.1"]);
    expect(resolveVersionMismatch("0.1.5-board.3", "0.1.5-board.4")).not.toBeNull();
  });

  it("leaves a server alone once it runs this build or a newer one", () => {
    expect(targets("0.1.5-board.4", "0.1.5-board.4")).toEqual([]);
    expect(targets("0.1.5-board.5", "0.1.5-board.4")).toEqual([]);
    expect(resolveVersionMismatch("0.1.5-board.10", "0.1.5-board.9")).toBeNull();
  });
});
