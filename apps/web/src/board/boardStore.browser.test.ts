import { createWorkflow } from "@t3tools/board-core/boardModel";
import type { BoardSnapshot } from "@t3tools/board-core/http";
import { expect, it, vi } from "vite-plus/test";

const snapshot: BoardSnapshot = {
  sequence: 1,
  workspaces: [],
  workflows: [createWorkflow("first", "First", "ws"), createWorkflow("second", "Second", "ws")],
  kanban: [],
  peers: [],
  schedules: [],
};

/** A fresh page load: the store module starts over, the browser's storage stays. */
async function loadPage() {
  vi.resetModules();
  const store = await import("./boardStore");
  store.setSnapshot(snapshot);
  return store;
}

it("reopens the workflow that was being viewed after a reload", async () => {
  localStorage.removeItem("t3.board.currentWorkflow");
  const before = await loadPage();
  expect(before.getCurrentWorkflow().id).toBe("first");
  before.setCurrentWorkflow("second");

  expect((await loadPage()).getCurrentWorkflow().id).toBe("second");
  localStorage.removeItem("t3.board.currentWorkflow");
});

it("places a new agent clear of the larger orchestrator and every earlier agent", async () => {
  const { nextNodePosition } = await loadPage();
  const nodes: Array<{ profile: "orchestrator" | "worker"; x: number; y: number }> = [];
  const add = (profile: "orchestrator" | "worker") => {
    nodes.push({ profile, ...nextNodePosition({ nodes } as never, profile) });
  };
  add("orchestrator");
  for (let worker = 0; worker < 5; worker++) add("worker");
  const size = (profile: string) => (profile === "orchestrator" ? 318 : 212);
  for (const [index, a] of nodes.entries())
    for (const b of nodes.slice(index + 1)) {
      const apart =
        a.x + size(a.profile) <= b.x ||
        b.x + size(b.profile) <= a.x ||
        a.y + size(a.profile) <= b.y ||
        b.y + size(b.profile) <= a.y;
      expect(apart).toBe(true);
    }
});
