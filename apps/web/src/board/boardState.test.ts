import { createWorkflow } from "@t3tools/board-core/boardModel";
import type { BoardSnapshot } from "@t3tools/board-core/http";
import { expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { applyBoardEvent, workflowView } from "./boardState";

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

it("shows a node's /new chat over the threads of runs started before it, but not after", () => {
  const environmentId = EnvironmentId.make("environment");
  const projectId = ProjectId.make("project");
  const thread = (id: string) => ({
    environmentId,
    projectId,
    threadId: ThreadId.make(id),
    seeded: true,
  });
  const base = createWorkflow("workflow", "Workflow", "workspace");
  const node = {
    id: "agent",
    name: "Agent",
    profile: "worker" as const,
    environmentId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    x: 0,
    y: 0,
  };
  const run = (id: string, startedAt: string) => ({
    id,
    nodeId: "agent",
    nodeName: "Agent",
    task: "task",
    status: "finished" as const,
    startedAt,
    requests: [],
    threads: { agent: thread(`${id}-thread`) },
    definition: { nodes: [node], edges: [], settings: base.settings },
  });
  const withChat = (chat: Partial<{ startedAt: string }>, runs: ReturnType<typeof run>[]) =>
    workflowView({
      ...base,
      nodes: [
        { ...node, chat: { environmentId, projectId, threadId: ThreadId.make("chat"), ...chat } },
      ],
      runs,
    }).nodes[0]?.threadId;

  const before = run("before", "2026-01-01T00:00:00.000Z");
  const after = run("after", "2026-01-03T00:00:00.000Z");
  // A chat opened the first time stays behind any run's thread.
  expect(withChat({}, [before])).toBe("before-thread");
  expect(withChat({ startedAt: "2026-01-02T00:00:00.000Z" }, [before])).toBe("chat");
  expect(withChat({ startedAt: "2026-01-02T00:00:00.000Z" }, [before, after])).toBe("after-thread");
});
