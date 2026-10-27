import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createWorkflow, type BoardNode, type Workflow } from "./boardModel.ts";
import {
  canHandoff,
  decideRouting,
  selectSettledMessages,
  validateGraph,
  validateRunnable,
} from "./routing.ts";
import type { BoardResult } from "./resultProtocol.ts";

const modelSelection = { instanceId: "codex", model: "gpt-6-luna" } as ModelSelection;
const node = (id: string, name = id): BoardNode => ({
  id,
  name,
  profile: "worker",
  environmentId: "env" as EnvironmentId,
  modelSelection,
  x: 0,
  y: 0,
});
const graph = (): Workflow => ({
  ...createWorkflow("w", "W", "ws"),
  nodes: [node("home", "Home"), node("worker", "Worker"), node("other", "Other")],
  edges: [{ a: "home", b: "worker" }],
});
const result = (routing: BoardResult["routing"]): BoardResult => ({
  summary: "done",
  data: null,
  routing,
});

describe("board routing", () => {
  it("reports ambiguous nodes and invalid or duplicate edges", () => {
    const workflow = graph();
    const problems = validateGraph({
      nodes: [...workflow.nodes, node("home", " WORKER ")],
      edges: [
        ...workflow.edges,
        { a: "worker", b: "home" },
        { a: "home", b: "missing" },
        { a: "home", b: "home" },
      ],
    });
    expect(problems.map((problem) => problem.kind)).toEqual([
      "duplicate-node-id",
      "duplicate-node-name",
      "duplicate-edge",
      "invalid-edge",
      "invalid-edge",
    ]);
  });

  it("allows one orchestrator, and workers only run under one", () => {
    const workflow = graph();
    const lead = { ...node("lead"), profile: "orchestrator" as const };
    const second = { ...node("second"), profile: "orchestrator" as const };
    expect(validateGraph({ ...workflow, nodes: [...workflow.nodes, lead, second] })).toEqual([
      { kind: "several-orchestrators" },
    ]);
    expect(validateGraph(workflow)).toEqual([]);
    expect(validateRunnable(workflow)).toEqual([{ kind: "no-orchestrator" }]);
    expect(validateRunnable({ ...workflow, nodes: [...workflow.nodes, lead] })).toEqual([]);
    expect(validateRunnable({ nodes: [lead], edges: [] })).toEqual([]);
  });

  it("selects all fresh settled assistant messages and only the newest result", () => {
    const messages = [
      { id: "old", role: "assistant", streaming: false, text: "old" },
      { id: "user", role: "user", streaming: false, text: "user" },
      { id: "new", role: "assistant", streaming: false, text: "new" },
      { id: "latest", role: "assistant", streaming: false, text: "latest" },
      { id: "streaming", role: "assistant", streaming: true, text: "partial" },
    ];
    const selected = selectSettledMessages(messages, new Set(["old"]));
    expect(selected.fresh.map((message) => message.id)).toEqual(["new", "latest"]);
    expect(selected.latest?.text).toBe("latest");
  });

  it("validates every target before returning any actions", () => {
    const decision = decideRouting(
      result({
        kind: "request",
        requests: [
          { to: " worker ", task: "first" },
          { to: "Other", task: "second" },
        ],
      }),
      graph(),
      "home",
    );
    expect(decision).toEqual({
      ok: false,
      reason: '"Other" is not a node you can send requests to',
    });
  });

  it("counts each accepted request in a fan-out against the directed edge cap", () => {
    const workflow: Workflow = {
      ...graph(),
      settings: { ...graph().settings, maxHandoffsPerEdge: 1 },
    };
    const decision = decideRouting(
      result({
        kind: "request",
        requests: [
          { to: "worker", task: "first" },
          { to: "WORKER", task: "second" },
        ],
      }),
      workflow,
      "home",
    );
    expect(decision.ok && decision.actions.map((action) => action.kind)).toEqual([
      "request",
      "denied",
    ]);
    expect(
      canHandoff(
        1,
        [
          {
            id: "1",
            fromId: "home",
            toId: "worker",
            from: "Home",
            to: "Worker",
            at: "",
            task: "x",
            status: "pending",
          },
        ],
        "home",
        "worker",
      ),
    ).toBe(false);
    expect(
      canHandoff(
        1,
        [
          {
            id: "1",
            fromId: "home",
            toId: "worker",
            from: "Home",
            to: "Worker",
            at: "",
            task: "x",
            status: "denied",
          },
        ],
        "home",
        "worker",
      ),
    ).toBe(true);
  });

  it("matches returns to the right requester and rejects ambiguous returns", () => {
    const pending = [
      { id: "p1", from: "home", to: "worker" },
      { id: "p2", from: "other", to: "worker" },
    ];
    expect(decideRouting(result({ kind: "return" }), graph(), "worker", pending)).toEqual({
      ok: false,
      reason: "requestId is required because several requests are pending",
    });
    expect(decideRouting(result({ kind: "finish" }), graph(), "worker", pending)).toEqual({
      ok: false,
      reason: "requestId is required because several requests are pending",
    });
    const decision = decideRouting(
      result({ kind: "return", requestId: "p2" }),
      graph(),
      "worker",
      pending,
    );
    expect(decision.ok && decision.actions[0]).toMatchObject({
      kind: "return",
      pending: pending[1],
    });
    const single = decideRouting(
      result({ kind: "finish" }),
      graph(),
      "worker",
      pending.slice(0, 1),
    );
    expect(single.ok && single.actions[0]).toMatchObject({ kind: "return", pending: pending[0] });
  });

  it("does not route a briefing reply outside a run", () => {
    const decision = decideRouting(
      result({ kind: "request", requests: [{ to: "worker", task: "x" }] }),
      graph(),
      "home",
      [],
      { briefing: true },
    );
    expect(decision).toEqual({ ok: true, actions: [{ kind: "ignore-briefing" }] });
  });
});
