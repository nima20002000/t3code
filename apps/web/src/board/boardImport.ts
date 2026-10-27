import { migrateBoards } from "@t3tools/board-core/boardModel";
import { BoardWorkflowSchema, type BoardSnapshot } from "@t3tools/board-core/http";
import * as Schema from "effect/Schema";

type Workflow = typeof BoardWorkflowSchema.Type;
const decodeWorkflows = Schema.decodeSync(Schema.Array(BoardWorkflowSchema));

export async function importLocalWorkflows(input: {
  readonly storage: Storage;
  readonly origin: string;
  readonly snapshot: BoardSnapshot;
  readonly newId: () => string;
  readonly send: (workflows: ReadonlyArray<Workflow>) => Promise<unknown>;
}) {
  const storageKey = `t3.board.imported.v2:${input.origin}`;
  if (input.storage.getItem(storageKey)) return;
  const raw = input.storage.getItem("t3.board.v2");
  if (raw !== null) {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { workflows?: unknown }).workflows)
    ) {
      throw new Error("The local board data is invalid. It has not been imported or removed.");
    }
    const source = (parsed as { workflows: unknown[] }).workflows;
    if (
      source.some(
        (workflow) =>
          typeof workflow !== "object" ||
          workflow === null ||
          typeof (workflow as { id?: unknown }).id !== "string",
      )
    ) {
      throw new Error("A local workflow is invalid. It has not been imported or removed.");
    }
    const migrated = migrateBoards(parsed, null, input.newId);
    const workflows = source.length === 0 ? [] : decodeWorkflows(migrated.workflows);
    const missing = workflows.filter(
      (workflow) => !input.snapshot.workflows.some((existing) => existing.id === workflow.id),
    );
    if (missing.length) await input.send(missing);
  }
  input.storage.setItem(storageKey, "1");
}
