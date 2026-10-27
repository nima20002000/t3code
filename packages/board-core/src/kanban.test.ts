import { describe, expect, it } from "vite-plus/test";
import {
  applyKanban,
  cardOfNode,
  kanbanDuty,
  moveCard,
  parseKanbanOps,
  type KanbanCard,
  type KanbanOp,
} from "./kanban.ts";
import { parseResult } from "./resultProtocol.ts";

const nodes = [
  { id: "n1", name: "Dev" },
  { id: "n2", name: "QA" },
];
const card = (id: string, patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id,
  title: id,
  body: "",
  status: "todo",
  updatedBy: "n0",
  updatedAt: "t0",
  ...patch,
});
let counter = 0;
const apply = (cards: ReadonlyArray<KanbanCard>, ops: ReadonlyArray<KanbanOp>) =>
  applyKanban({ cards, ops, nodes, actor: "boss", at: "t1", newId: () => `new${++counter}` });

describe("parseKanbanOps", () => {
  it("accepts the three operations", () => {
    expect(
      parseKanbanOps([
        { op: "create", title: " Parser ", assignee: "Dev" },
        { op: "update", id: "c1", status: "blocked", reason: "no spec", assignee: null },
        { op: "delete", id: "c2" },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { op: "create", title: "Parser", assignee: "Dev" },
        { op: "update", id: "c1", status: "blocked", reason: "no spec", assignee: null },
        { op: "delete", id: "c2" },
      ],
    });
  });

  it("rejects bad shapes with a reason the agent can act on", () => {
    expect(parseKanbanOps("x")).toMatchObject({ ok: false });
    expect(parseKanbanOps([{ op: "create" }])).toMatchObject({
      reason: 'kanban operation 0 needs a "title"',
    });
    expect(parseKanbanOps([{ op: "update", id: "c", status: "stuck" }])).toMatchObject({
      reason: 'kanban operation 0: "status" is invalid',
    });
    expect(parseKanbanOps([{ op: "move", id: "c" }])).toMatchObject({ ok: false });
    expect(
      parseKanbanOps(Array.from({ length: 33 }, () => ({ op: "delete", id: "c" }))),
    ).toMatchObject({ ok: false });
  });

  it("rides in the reply envelope and is dropped when empty", () => {
    const text = (kanban: string) =>
      `\`\`\`json\n{"summary":"s","routing":{"kind":"finish"}${kanban}}\n\`\`\``;
    const withOps = parseResult(text(',"kanban":[{"op":"delete","id":"c"}]'));
    expect(withOps).toMatchObject({ ok: true, result: { kanban: [{ op: "delete", id: "c" }] } });
    const none = parseResult(text(""));
    expect(none.ok && "kanban" in none.result).toBe(false);
    expect(parseResult(text(',"kanban":[{"op":"create"}]'))).toMatchObject({ ok: false });
  });
});

describe("applyKanban", () => {
  it("creates, updates and deletes, stamping the actor", () => {
    const result = apply(
      [card("c1"), card("c2")],
      [
        { op: "create", title: "New", assignee: " qa " },
        { op: "update", id: "c1", status: "doing" },
        { op: "delete", id: "c2" },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cards.map((entry) => entry.id)).toEqual([
      "c1",
      expect.stringMatching(/^new/),
    ]);
    expect(result.value.cards[0]).toMatchObject({
      status: "doing",
      updatedBy: "boss",
      updatedAt: "t1",
    });
    expect(result.value.cards[1]).toMatchObject({ assigneeNodeId: "n2", status: "todo" });
    expect(result.value.upserted).toHaveLength(2);
    expect(result.value.deleted).toEqual(["c2"]);
  });

  it("requires a reason for blocked and clears it when the card leaves blocked", () => {
    expect(apply([card("c1")], [{ op: "update", id: "c1", status: "blocked" }])).toMatchObject({
      ok: false,
      reason: 'kanban operation 0: a blocked card needs a "reason"',
    });
    const blocked = apply(
      [card("c1")],
      [{ op: "update", id: "c1", status: "blocked", reason: "waiting" }],
    );
    expect(blocked.ok && blocked.value.cards[0]?.reason).toBe("waiting");
    const reopened = apply(blocked.ok ? blocked.value.cards : [], [
      { op: "update", id: "c1", status: "doing" },
    ]);
    expect(reopened.ok && reopened.value.cards[0]).not.toHaveProperty("reason");
  });

  it("changes nothing when any operation is invalid", () => {
    expect(
      apply(
        [card("c1")],
        [
          { op: "update", id: "c1", status: "done" },
          { op: "create", title: "x", assignee: "Nobody" },
        ],
      ),
    ).toMatchObject({ ok: false, reason: 'kanban operation 1: unknown node "Nobody"' });
    expect(apply([card("c1")], [{ op: "delete", id: "zzz" }])).toMatchObject({ ok: false });
    expect(apply([card("c1")], [{ op: "create", id: "c1", title: "dup" }])).toMatchObject({
      ok: false,
    });
  });

  it("unassigns with a null assignee", () => {
    const result = apply(
      [card("c1", { assigneeNodeId: "n1" })],
      [{ op: "update", id: "c1", assignee: null }],
    );
    expect(result.ok && result.value.cards[0]).not.toHaveProperty("assigneeNodeId");
  });
});

describe("engine moves", () => {
  const cards = [
    card("done", { assigneeNodeId: "n1", status: "done" }),
    card("a", { assigneeNodeId: "n1" }),
    card("b", { assigneeNodeId: "n1", status: "doing" }),
    card("other", { assigneeNodeId: "n2" }),
  ];

  it("finds the oldest open card of a node in the wanted statuses", () => {
    expect(cardOfNode(cards, "n1", ["todo", "blocked"])?.id).toBe("a");
    expect(cardOfNode(cards, "n1", ["doing"])?.id).toBe("b");
    expect(cardOfNode(cards, "n3", ["todo"])).toBeUndefined();
  });

  it("moves a card as the engine and keeps a reason only for blocked", () => {
    const blocked = moveCard(cards[1]!, "blocked", "t9", "failed");
    expect(blocked).toMatchObject({ status: "blocked", reason: "failed", updatedBy: "engine" });
    expect(moveCard(blocked, "done", "t10")).not.toHaveProperty("reason");
  });
});

describe("kanbanDuty", () => {
  const card = (id: string, status: KanbanCard["status"], assigneeNodeId?: string): KanbanCard => ({
    id,
    title: id,
    body: "",
    status,
    ...(status === "blocked" || status === "waiting_for_human" ? { reason: "why" } : {}),
    ...(assigneeNodeId ? { assigneeNodeId } : {}),
    updatedBy: "root",
    updatedAt: "2026-10-27T00:00:00.000Z",
  });
  const worker = { id: "w", name: "Worker" };

  it("requires an open card for every worker given work", () => {
    expect(kanbanDuty({ cards: [], requested: [worker], finishingRun: false })).toContain(
      "missing for Worker",
    );
    expect(
      kanbanDuty({ cards: [card("c", "done", "w")], requested: [worker], finishingRun: false }),
    ).toContain("missing for Worker");
    expect(
      kanbanDuty({ cards: [card("c", "todo", "w")], requested: [worker], finishingRun: false }),
    ).toBeUndefined();
  });

  it("lets a run finish only with nothing left in todo or doing", () => {
    expect(
      kanbanDuty({ cards: [card("c", "doing", "w")], requested: [], finishingRun: true }),
    ).toContain('c "c"');
    expect(
      kanbanDuty({
        cards: [card("a", "done"), card("b", "blocked"), card("c", "waiting_for_human")],
        requested: [],
        finishingRun: true,
      }),
    ).toBeUndefined();
  });
});
