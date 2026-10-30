import { createWorkflow } from "@t3tools/board-core/boardModel";
import type { BoardSnapshot } from "@t3tools/board-core/http";
import { expect, it } from "vite-plus/test";

import { applyBoardEvent, nextFreeName } from "./boardState";

const snapshot: BoardSnapshot = {
  sequence: 4,
  workspaces: [],
  workflows: [],
  kanban: [],
  peers: [],
  schedules: [],
};

it("applies sequenced events and ignores replayed events", () => {
  const workflow = createWorkflow("w1", "Example", "ws");
  const updated = applyBoardEvent(snapshot, { kind: "workflow.upserted", sequence: 5, workflow });
  expect(updated.workflows).toEqual([workflow]);
  expect(
    applyBoardEvent(updated, { kind: "workflow.deleted", sequence: 4, workflowId: "w1" }),
  ).toBe(updated);
  expect(
    applyBoardEvent(updated, { kind: "workflow.deleted", sequence: 6, workflowId: "w1" }).workflows,
  ).toEqual([]);
});

it("keeps pending handoffs in step with run events", () => {
  const workflow = createWorkflow("w1", "Example", "ws");
  const initial = { ...snapshot, workflows: [workflow] };
  const run = {
    id: "run",
    nodeId: "a",
    nodeName: "A",
    task: "work",
    status: "running" as const,
    startedAt: "2026-01-01T00:00:00Z",
    requests: [],
    threads: {},
    definition: { nodes: [], edges: [], settings: workflow.settings },
  };
  const pending = [{ id: "handoff", from: "a", to: "b" }];
  const waiting = applyBoardEvent(initial, {
    kind: "run.upserted",
    sequence: 5,
    workflowId: workflow.id,
    run,
    pending,
  });
  expect(waiting.workflows[0]?.pending).toEqual(pending);
  const completed = applyBoardEvent(waiting, {
    kind: "run.upserted",
    sequence: 6,
    workflowId: workflow.id,
    run: { ...run, status: "finished" },
    pending: [],
  });
  expect(completed.workflows[0]?.pending).toEqual([]);
});

it("keeps workspaces and a workflow's kanban in step with their events", () => {
  const workspace = { id: "ws", name: "Workspace", folders: [] };
  const card = {
    id: "c1",
    title: "Parser",
    body: "",
    status: "todo" as const,
    updatedBy: "engine",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  let current = applyBoardEvent(snapshot, { kind: "workspace.upserted", sequence: 5, workspace });
  expect(current.workspaces).toEqual([workspace]);
  current = applyBoardEvent(current, {
    kind: "kanban.upserted",
    sequence: 6,
    workflowId: "w1",
    card,
  });
  current = applyBoardEvent(current, {
    kind: "kanban.upserted",
    sequence: 7,
    workflowId: "w1",
    card: { ...card, status: "doing" },
  });
  expect(current.kanban).toEqual([{ workflowId: "w1", cards: [{ ...card, status: "doing" }] }]);
  current = applyBoardEvent(current, {
    kind: "kanban.deleted",
    sequence: 8,
    workflowId: "w1",
    cardId: "c1",
  });
  expect(current.kanban[0]?.cards).toEqual([]);
  expect(
    applyBoardEvent(current, { kind: "workspace.deleted", sequence: 9, workspaceId: "ws" })
      .workspaces,
  ).toEqual([]);
});

it("suggests the first free default name", () => {
  expect(nextFreeName("Workspace", [])).toBe("Workspace");
  expect(nextFreeName("Workspace", ["workspace", "Workspace 2", "Other"])).toBe("Workspace 3");
  expect(nextFreeName("Workspace", ["Workspace 2"])).toBe("Workspace");
});
