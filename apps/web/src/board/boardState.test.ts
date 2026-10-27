import { createWorkflow } from "@t3tools/board-core/boardModel";
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
  };
  await expect(
    importLocalWorkflows({
      ...input,
      send: async () => {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow("offline");
  expect(values.has("t3.board.imported.v2:https://hub.example")).toBe(false);
  let imported: unknown;
  await importLocalWorkflows({
    ...input,
    send: async (workflows) => {
      imported = workflows;
    },
  });
  expect(imported).toEqual([second]);
  expect(values.get("t3.board.imported.v2:https://hub.example")).toBe("1");
  expect(values.has("t3.board.v2")).toBe(true);
  await importLocalWorkflows({
    ...input,
    send: async () => {
      throw new Error("must not import twice");
    },
  });
});
