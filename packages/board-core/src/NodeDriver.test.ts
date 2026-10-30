import type { OrchestrationV2PlanArtifact, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { latestTodoList } from "./NodeDriver.ts";

const run = RunId.make("run-1");
const list = (planId: string, text: string, ordinal: number, runId = run) => ({
  plan: {
    id: planId,
    runId,
    kind: "todo_list",
    status: "active",
    steps: [{ id: "step-1", text, status: "pending" }],
  } as unknown as OrchestrationV2PlanArtifact,
  item: {
    type: "todo_list",
    planId,
    runId,
    ordinal,
    steps: [{ id: "step-1", text, status: "pending" }],
  } as unknown as OrchestrationV2TurnItem,
});
const texts = (steps: ReturnType<typeof latestTodoList>) => steps?.map((step) => step.text);

describe("latestTodoList", () => {
  it("picks the run's newest list even when an older one has the larger plan id", () => {
    const older = list("plan-z", "Old list", 3);
    const newer = list("plan-a", "New list", 9);
    const otherRun = list("plan-b", "Other run", 12, RunId.make("run-2"));
    expect(
      texts(
        latestTodoList(
          {
            plans: [newer.plan, otherRun.plan, older.plan],
            turnItems: [older.item, newer.item, otherRun.item],
          },
          run,
        ),
      ),
    ).toEqual(["New list"]);
  });

  it("falls back to the run's plans when the timeline no longer holds its items, and is null without a list", () => {
    const only = list("plan-a", "Only list", 1);
    expect(texts(latestTodoList({ plans: [only.plan], turnItems: [] }, run))).toEqual([
      "Only list",
    ]);
    expect(latestTodoList({ plans: [], turnItems: [] }, run)).toBeNull();
  });
});
