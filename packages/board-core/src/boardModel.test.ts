import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_HISTORY,
  applySnapshot,
  createHistory,
  createWorkflow,
  defaultFolder,
  discardHistory,
  recordHistory,
  redoHistory,
  snapshotOf,
  snapshotsEqual,
  uniqueWorkflowName,
  workspaceNameTaken,
  workspaceSlug,
  undoHistory,
  type BoardNode,
  type EditSnapshot,
} from "./boardModel.ts";

const modelSelection = { instanceId: "codex", model: "gpt-6-luna" } as ModelSelection;
const node = (id: string, patch: Partial<BoardNode> = {}): BoardNode => ({
  id,
  name: id,
  profile: "worker",
  environmentId: "env" as EnvironmentId,
  modelSelection,
  x: 0,
  y: 0,
  ...patch,
});

describe("workspaces", () => {
  const workspace = { id: "w1", name: "Big Project!", folders: [] };

  it("slugs the name into a folder name", () => {
    expect(workspaceSlug("Big Project!")).toBe("big-project");
    expect(workspaceSlug("  ")).toBe("workspace");
  });

  it("rejects a name whose folder slug collides with another workspace", () => {
    const others = [{ id: "w2", name: "My Board" }];
    expect(workspaceNameTaken(others, "My-Board")).toBe(true);
    expect(workspaceNameTaken(others, "My Board", "w2")).toBe(false);
    expect(workspaceNameTaken(others, "Other")).toBe(false);
  });

  it("gives a machine its default folder under the t3 workspaces root", () => {
    expect(defaultFolder(workspace, "env" as EnvironmentId, "u1")).toEqual({
      environmentId: "env",
      projectId: "board:w1:u1",
      path: "~/t3-workspaces/big-project",
      managed: true,
    });
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
  it("replaces nodes and edges and drops wakes of removed nodes", () => {
    const workflow = {
      ...createWorkflow("w", "W", "ws"),
      nodes: [node("a"), node("b")],
      pending: [
        { id: "p1", from: "a", to: "b" },
        { id: "p2", from: "a", to: "c" },
      ],
    };
    const snapshot: EditSnapshot = { nodes: [node("a", { x: 5 })], edges: [] };
    const next = applySnapshot(workflow, snapshot);
    expect(next.nodes[0]).toMatchObject({ x: 5 });
    expect(next.pending).toEqual([]);
    expect(snapshotOf(next).edges).toBe(snapshot.edges);
  });
});
