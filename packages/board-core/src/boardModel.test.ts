import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_WORKFLOW_SETTINGS,
  MAX_HISTORY,
  applySnapshot,
  createHistory,
  createWorkflow,
  discardHistory,
  migrateBoards,
  recordHistory,
  redoHistory,
  snapshotOf,
  snapshotsEqual,
  uniqueWorkflowName,
  undoHistory,
  type BoardNode,
  type EditSnapshot,
} from "./boardModel.ts";

const node = (id: string, patch: Partial<BoardNode> = {}): BoardNode => ({
  id,
  name: id,
  environmentId: "env" as EnvironmentId,
  threadId: `thread-${id}` as ThreadId,
  x: 0,
  y: 0,
  baselined: true,
  ...patch,
});

describe("migrateBoards", () => {
  it("turns the legacy single board into a workflow named Workflow", () => {
    const legacy = {
      nodes: [node("a")],
      edges: [{ a: "a", b: "a" }],
      pending: [],
      log: [{ id: "l", at: "t", kind: "info", text: "x" }],
      runQueue: [],
    };
    const boards = migrateBoards(null, legacy, () => "w1");
    expect(boards.currentId).toBe("w1");
    expect(boards.workflows).toHaveLength(1);
    const [workflow] = boards.workflows;
    expect(workflow?.name).toBe("Workflow");
    expect(workflow?.nodes).toEqual(legacy.nodes);
    expect(workflow?.log).toHaveLength(1);
    expect(workflow?.runs).toEqual([]);
    expect(workflow?.settings).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  });

  it("gives one empty workflow when nothing is stored", () => {
    const boards = migrateBoards(null, null, () => "w1");
    expect(boards.workflows).toEqual([createWorkflow("w1", "Workflow")]);
  });

  it("keeps v2 data, fills missing fields and repairs the current id", () => {
    const boards = migrateBoards(
      { workflows: [{ id: "x", name: "Two", nodes: [node("a")] }], currentId: "missing" },
      { nodes: [node("legacy")] },
      () => "never",
    );
    expect(boards.currentId).toBe("x");
    expect(boards.workflows[0]?.name).toBe("Two");
    expect(boards.workflows[0]?.nodes).toHaveLength(1);
    expect(boards.workflows[0]?.runs).toEqual([]);
    expect(boards.workflows[0]?.settings.defaultModel).toBe("gpt-6-luna");
  });
});

describe("uniqueWorkflowName", () => {
  it("numbers duplicates", () => {
    expect(uniqueWorkflowName(["Workflow"], "Workflow")).toBe("Workflow 2");
    expect(uniqueWorkflowName(["Workflow", "Workflow 2"], "Workflow")).toBe("Workflow 3");
    expect(uniqueWorkflowName([], "Workflow")).toBe("Workflow");
  });
});

describe("history", () => {
  const empty: EditSnapshot = { nodes: [], edges: [] };
  const one: EditSnapshot = { nodes: [node("a")], edges: [] };
  const two: EditSnapshot = { nodes: [node("a"), node("b")], edges: [] };

  it("undoes and redoes", () => {
    let history = createHistory(empty);
    history = recordHistory(history, empty); // before adding a
    history = recordHistory(history, one); // before adding b
    const undone = undoHistory(history, two);
    expect(undone?.snapshot).toBe(one);
    const redone = redoHistory(undone!.history, one);
    expect(redone?.snapshot).toBe(two);
    expect(redone?.history.past).toHaveLength(2);
  });

  it("returns null when there is nothing to undo or redo", () => {
    const history = createHistory(empty);
    expect(undoHistory(history, empty)).toBeNull();
    expect(redoHistory(history, empty)).toBeNull();
  });

  it("clears redo on a new edit and caps the past", () => {
    let history = recordHistory(createHistory(empty), empty);
    history = undoHistory(history, one)!.history;
    expect(history.future).toHaveLength(1);
    history = recordHistory(history, empty);
    expect(history.future).toHaveLength(0);
    for (let index = 0; index < MAX_HISTORY + 20; index++) {
      history = recordHistory(history, { nodes: [node(String(index))], edges: [] });
    }
    expect(history.past).toHaveLength(MAX_HISTORY);
  });

  it("discard returns to the origin and resets history", () => {
    let history = createHistory(one);
    history = recordHistory(history, one);
    const discarded = discardHistory(history);
    expect(discarded.snapshot).toBe(one);
    expect(discarded.history.past).toEqual([]);
    expect(snapshotsEqual(discarded.snapshot, one)).toBe(true);
    expect(snapshotsEqual(two, one)).toBe(false);
  });
});

describe("applySnapshot", () => {
  it("keeps engine flags of surviving nodes and drops wakes of removed nodes", () => {
    const workflow = {
      ...createWorkflow("w", "W"),
      nodes: [node("a", { baselined: true, awaitingFirstReply: false }), node("b")],
      pending: [
        { id: "p1", from: "a", to: "b" },
        { id: "p2", from: "a", to: "c" },
      ],
    };
    const snapshot: EditSnapshot = {
      nodes: [node("a", { baselined: false, awaitingFirstReply: true, x: 5 })],
      edges: [],
    };
    const next = applySnapshot(workflow, snapshot);
    expect(next.nodes[0]).toMatchObject({ x: 5, baselined: true, awaitingFirstReply: false });
    expect(next.pending).toEqual([]);
    expect(snapshotOf(next).edges).toBe(snapshot.edges);
  });
});
