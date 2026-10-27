import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { BoardNode, RunRecord, RunRequestRecord } from "./boardModel.ts";
import { runToShow, runViews, type NodeLiveFacts } from "./runView.ts";

const node = (id: string): BoardNode => ({
  id,
  name: id,
  environmentId: "env" as EnvironmentId,
  threadId: id as ThreadId,
  x: 0,
  y: 0,
  baselined: true,
});
const nodes = [node("Home"), node("Italy"), node("Researcher"), node("Spare")];
const edges = [
  { a: "Home", b: "Italy" },
  { a: "Home", b: "Researcher" },
];
const request = (
  id: string,
  to: string,
  status: RunRequestRecord["status"],
  at: string,
): RunRequestRecord => ({
  id,
  fromId: "Home",
  toId: to,
  from: "Home",
  to,
  at,
  task: "work",
  status,
  ...(status === "returned" ? { returnedAt: `${at}+r` } : {}),
});
const run = (status: RunRecord["status"], requests: RunRequestRecord[]): RunRecord => ({
  id: "run",
  nodeId: "Home",
  nodeName: "Home",
  task: "task",
  status,
  startedAt: "t0",
  requests,
});
const facts =
  (working: ReadonlyArray<string> = [], offline: ReadonlyArray<string> = []) =>
  (target: BoardNode): NodeLiveFacts => ({
    connected: !offline.includes(target.id),
    turnActive: working.includes(target.id),
  });
const states = (views: ReturnType<typeof runViews>) =>
  Object.fromEntries([...views.nodes].map(([id, view]) => [id, `${view.state}: ${view.label}`]));

describe("board run views", () => {
  it("shows a fan-out join: requester waiting, workers working or queued, bystander idle", () => {
    const views = runViews(
      run("running", [
        request("r1", "Italy", "returned", "t1"),
        request("r2", "Researcher", "pending", "t2"),
      ]),
      nodes,
      edges,
      facts(["Researcher"]),
    );
    expect(states(views)).toEqual({
      Home: "waiting: Waiting for Researcher",
      Italy: "completed: Returned to Home",
      Researcher: "running: Working for Home",
      Spare: "idle: Idle",
    });
    expect(views.edges.get("Home:Researcher")).toMatchObject({ pending: 1, signal: "task" });
    expect(views.edges.get("Home:Italy")?.crossings.map((crossing) => crossing.key)).toEqual([
      "r1:task",
      "r1:return",
    ]);
  });

  it("counts open returns and marks a delivered request that has not started as queued", () => {
    const views = runViews(
      run("running", [
        request("r1", "Italy", "pending", "t1"),
        request("r2", "Researcher", "pending", "t2"),
      ]),
      nodes,
      edges,
      facts(),
    );
    expect(states(views)).toMatchObject({
      Home: "waiting: Waiting for 0 of 2 returns",
      Italy: "queued: Starting · from Home",
    });
  });

  it("shows stopping while turns wind down, and an offline machine over everything", () => {
    const views = runViews(
      run("stopping", [request("r1", "Italy", "pending", "t1")]),
      nodes,
      edges,
      facts(["Italy"], ["Researcher"]),
    );
    expect(states(views)).toMatchObject({
      Home: "idle: Stopped",
      Italy: "waiting: Stopping",
      Researcher: "unavailable: Machine offline",
    });
  });

  it("keeps the last run's outcome and clears live edge state once it ended", () => {
    const views = runViews(
      run("finished", [
        request("r1", "Italy", "returned", "t1"),
        request("r2", "Researcher", "failed", "t2"),
      ]),
      nodes,
      edges,
      facts(),
    );
    expect(states(views)).toMatchObject({
      Home: "completed: Finished",
      Researcher: "failed: Request failed",
    });
    expect(views.edges.get("Home:Italy")).toMatchObject({ pending: 0 });
    expect(views.edges.get("Home:Italy")?.signal).toBeUndefined();
  });

  it("draws the newest finished run by start time, whatever the stored order", () => {
    const older = { ...run("finished", []), id: "older", startedAt: "2026-10-27T10:00:00.000Z" };
    const newer = { ...run("stopped", []), id: "newer", startedAt: "2026-10-27T11:00:00.000Z" };
    expect(runToShow([newer, older])?.id).toBe("newer");
    expect(runToShow([older, newer])?.id).toBe("newer");
  });

  it("draws the active run over newer finished ones", () => {
    const active = run("running", []);
    expect(runToShow([run("finished", []), active, { ...run("stopped", []), id: "later" }])).toBe(
      active,
    );
  });
});
