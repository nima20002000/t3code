import { createWorkflow, type Workflow } from "@t3tools/board-core/boardModel";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { BoardSnapshot } from "@t3tools/board-core/http";
import { expect, it } from "vite-plus/test";

import { applyBoardEvent } from "./boardState";
import { importLocalWorkflows } from "./boardImport";

const snapshot: BoardSnapshot = { sequence: 4, workflows: [], peers: [], schedules: [] };

it("applies sequenced events and ignores replayed events", () => {
  const workflow = createWorkflow("w1", "Example");
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
  const workflow = createWorkflow("w1", "Example");
  const initial = { ...snapshot, workflows: [workflow] };
  const run = {
    id: "run",
    nodeId: "a",
    nodeName: "A",
    task: "work",
    status: "running" as const,
    startedAt: "2026-01-01T00:00:00Z",
    requests: [],
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

it("only marks a local import after it succeeds and skips IDs already on the hub", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
  const first = createWorkflow("first", "First");
  const second = createWorkflow("second", "Second");
  values.set("t3.board.v2", JSON.stringify({ currentId: "first", workflows: [first, second] }));
  const input = {
    storage,
    origin: "https://hub.example",
    snapshot: { ...snapshot, workflows: [first] },
    newId: () => "unused",
    projectIdForNode: () => undefined,
  };
  await expect(
    importLocalWorkflows({
      ...input,
      send: async () => {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow("offline");
  expect(values.has("t3.board.imported.v3:https://hub.example")).toBe(false);
  let imported: unknown;
  await importLocalWorkflows({
    ...input,
    send: async (workflows) => {
      imported = workflows;
    },
  });
  expect(imported).toEqual([second]);
  expect(values.get("t3.board.imported.v3:https://hub.example")).toBe("1");
  expect(values.has("t3.board.v2")).toBe(true);
  await importLocalWorkflows({
    ...input,
    send: async () => {
      throw new Error("must not import twice");
    },
  });
});

it("does not leave old in-flight runs or queued work looking active after import", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
  const workflow = {
    ...createWorkflow("active", "Active"),
    pending: [{ id: "wake", from: "a", to: "b" }],
    runQueue: [{ id: "queued", nodeId: "a", task: "queued task" }],
    runs: [
      {
        id: "run",
        nodeId: "a",
        nodeName: "A",
        task: "task",
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        requests: [],
      },
    ],
  };
  values.set("t3.board.v2", JSON.stringify({ currentId: workflow.id, workflows: [workflow] }));
  let imported: Workflow | undefined;
  await importLocalWorkflows({
    storage,
    origin: "https://hub.example",
    snapshot,
    newId: () => "unused",
    projectIdForNode: () => undefined,
    send: async (workflows) => {
      imported = workflows[0];
    },
  });
  expect(imported?.pending).toEqual([]);
  expect(imported?.runQueue).toEqual([]);
  expect(imported?.runs[0]?.status).toBe("stopped");
  expect(imported?.log[0]?.text).toContain("stopped during import");
});

it("resolves legacy node projects before importing and keeps unresolved workflows for retry", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
  const node = {
    id: "node",
    name: "Scout",
    environmentId: EnvironmentId.make("peer"),
    threadId: ThreadId.make("thread"),
    x: 0,
    y: 0,
    baselined: true,
  };
  const workflow = { ...createWorkflow("legacy", "Legacy"), nodes: [node] };
  const raw = JSON.stringify({ currentId: workflow.id, workflows: [workflow] });
  values.set("t3.board.v2", raw);
  let imported: ReadonlyArray<Workflow> = [];
  const input = {
    storage,
    origin: "https://hub.example",
    snapshot,
    newId: () => "unused",
    send: async (workflows: ReadonlyArray<Workflow>) => {
      imported = workflows;
    },
  };
  await expect(
    importLocalWorkflows({ ...input, projectIdForNode: () => undefined }),
  ).rejects.toThrow("Connect the machine for Scout");
  expect(imported).toEqual([]);
  expect(values.get("t3.board.v2")).toBe(raw);
  expect(values.has("t3.board.imported.v3:https://hub.example")).toBe(false);

  await importLocalWorkflows({
    ...input,
    projectIdForNode: (candidate) =>
      candidate.environmentId === node.environmentId && candidate.threadId === node.threadId
        ? ProjectId.make("project")
        : undefined,
  });
  expect(imported[0]?.nodes[0]?.projectId).toBe(ProjectId.make("project"));
  expect(values.get("t3.board.imported.v3:https://hub.example")).toBe("1");
});

it("imports the legacy v1 board when v2 is absent", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
  values.set("t3.board.v1", JSON.stringify({ nodes: [], edges: [], pending: [], log: [] }));
  let imported: ReadonlyArray<Workflow> = [];
  await importLocalWorkflows({
    storage,
    origin: "https://hub.example",
    snapshot,
    newId: () => "unused",
    projectIdForNode: () => undefined,
    send: async (workflows) => {
      imported = workflows;
    },
  });
  expect(imported.map((workflow) => workflow.name)).toEqual(["Workflow"]);
  expect(values.get("t3.board.imported.v3:https://hub.example")).toBe("1");
});
