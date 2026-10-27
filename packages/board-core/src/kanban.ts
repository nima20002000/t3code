/** Per-workflow kanban. Only the orchestrator edits it (reply operations); the engine moves assigned cards. */

export type KanbanStatus = "todo" | "doing" | "waiting_for_human" | "blocked" | "done";
export const KANBAN_STATUSES: ReadonlyArray<KanbanStatus> = [
  "todo",
  "doing",
  "waiting_for_human",
  "blocked",
  "done",
];
/** Statuses that say why the card is stuck, so they need a "reason". */
export const needsReason = (status: KanbanStatus) =>
  status === "blocked" || status === "waiting_for_human";

export interface KanbanCard {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: KanbanStatus;
  /** Required for `blocked`; absent otherwise. */
  readonly reason?: string;
  readonly assigneeNodeId?: string;
  /** The node id that last changed the card, or "engine". */
  readonly updatedBy: string;
  readonly updatedAt: string;
  /** The run the card was created in; cards from before runs were recorded have none. */
  readonly runId?: string;
  /** Status changes, oldest first: who moved the card where and when (the newest MAX_CARD_MOVES). */
  readonly moves?: ReadonlyArray<KanbanMove>;
}

export interface KanbanMove {
  readonly status: KanbanStatus;
  readonly by: string;
  readonly at: string;
}
export const MAX_CARD_MOVES = 20;
const withMove = (
  card: Omit<KanbanCard, "moves"> & { readonly moves?: ReadonlyArray<KanbanMove> | undefined },
  previous: KanbanCard | undefined,
): KanbanCard => {
  const moves = previous?.moves ?? [];
  const { moves: _ignored, ...rest } = card;
  return {
    ...rest,
    moves:
      previous?.status === card.status
        ? moves
        : [...moves, { status: card.status, by: card.updatedBy, at: card.updatedAt }].slice(
            -MAX_CARD_MOVES,
          ),
  };
};

export type KanbanOp =
  | {
      readonly op: "create";
      readonly id?: string;
      readonly title: string;
      readonly body?: string;
      readonly status?: KanbanStatus;
      readonly reason?: string;
      readonly assignee?: string;
    }
  | {
      readonly op: "update";
      readonly id: string;
      readonly title?: string;
      readonly body?: string;
      readonly status?: KanbanStatus;
      readonly reason?: string;
      /** A node name, or null to unassign. */
      readonly assignee?: string | null;
    }
  | { readonly op: "delete"; readonly id: string };

export const MAX_KANBAN_OPS = 32;
export const MAX_CARD_TITLE = 240;
export const MAX_CARD_BODY = 8000;
export const MAX_CARD_REASON = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStatus = (value: unknown): value is KanbanStatus =>
  KANBAN_STATUSES.includes(value as KanbanStatus);

type Parsed<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

/** Shape check of the reply's `kanban` field. Whether the operations fit the cards is applyKanban's job. */
export function parseKanbanOps(raw: unknown): Parsed<ReadonlyArray<KanbanOp>> {
  if (!Array.isArray(raw)) return { ok: false, reason: '"kanban" must be an array of operations' };
  if (raw.length > MAX_KANBAN_OPS)
    return { ok: false, reason: `"kanban" holds at most ${MAX_KANBAN_OPS} operations` };
  const ops: KanbanOp[] = [];
  for (const [index, item] of raw.entries()) {
    const where = `kanban operation ${index}`;
    if (!isRecord(item)) return { ok: false, reason: `${where} must be an object` };
    const text = (key: string) => {
      const value = item[key];
      return value === undefined ? undefined : typeof value === "string" ? value.trim() : null;
    };
    const bad = (key: string) => ({ ok: false as const, reason: `${where}: "${key}" is invalid` });
    for (const key of ["id", "title", "body", "reason"]) if (text(key) === null) return bad(key);
    if (item.status !== undefined && !isStatus(item.status)) return bad("status");
    if (item.assignee !== undefined && item.assignee !== null && typeof item.assignee !== "string")
      return bad("assignee");
    const id = text("id");
    const title = text("title");
    const body = text("body");
    const reason = text("reason");
    const status = item.status as KanbanStatus | undefined;
    const optional = {
      ...(body === undefined ? {} : { body: body as string }),
      ...(status === undefined ? {} : { status }),
      ...(reason === undefined || reason === "" ? {} : { reason: reason as string }),
    };
    switch (item.op) {
      case "create":
        if (typeof title !== "string" || title === "")
          return { ok: false, reason: `${where} needs a "title"` };
        ops.push({
          op: "create",
          title,
          ...(typeof id === "string" && id !== "" ? { id } : {}),
          ...optional,
          ...(typeof item.assignee === "string" ? { assignee: item.assignee } : {}),
        });
        break;
      case "update":
        if (typeof id !== "string" || id === "")
          return { ok: false, reason: `${where} needs an "id"` };
        ops.push({
          op: "update",
          id,
          ...(typeof title === "string" && title !== "" ? { title } : {}),
          ...optional,
          ...(item.assignee === undefined ? {} : { assignee: item.assignee as string | null }),
        });
        break;
      case "delete":
        if (typeof id !== "string" || id === "")
          return { ok: false, reason: `${where} needs an "id"` };
        ops.push({ op: "delete", id });
        break;
      default:
        return { ok: false, reason: `${where}: "op" must be "create", "update" or "delete"` };
    }
  }
  return { ok: true, value: ops };
}

export interface KanbanChange {
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly upserted: ReadonlyArray<KanbanCard>;
  readonly deleted: ReadonlyArray<string>;
}

/**
 * Applies the orchestrator's operations to the cards, all or nothing. `actor` is the writing node's
 * id; assignees are node names. A blocked card needs a reason; other statuses carry none.
 */
export function applyKanban(input: {
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly ops: ReadonlyArray<KanbanOp>;
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly actor: string;
  readonly at: string;
  readonly newId: () => string;
  /** The run new cards belong to. */
  readonly runId?: string | undefined;
}): Parsed<KanbanChange> {
  const cards = new Map(input.cards.map((card) => [card.id, card]));
  const upserted = new Set<string>();
  const deleted = new Set<string>();
  const assign = (name: string): Parsed<string> => {
    const wanted = name.trim().toLowerCase();
    const node = input.nodes.find((entry) => entry.name.trim().toLowerCase() === wanted);
    return node ? { ok: true, value: node.id } : { ok: false, reason: `unknown node "${name}"` };
  };
  const finish = (
    draft: {
      readonly id: string;
      readonly title: string;
      readonly body: string;
      readonly status: KanbanStatus;
      readonly reason?: string | undefined;
      readonly assigneeNodeId?: string | undefined;
    },
    where: string,
    previous?: KanbanCard,
  ): Parsed<KanbanCard> => {
    if (draft.title.length > MAX_CARD_TITLE)
      return { ok: false, reason: `${where}: title is longer than ${MAX_CARD_TITLE} characters` };
    if (draft.body.length > MAX_CARD_BODY)
      return { ok: false, reason: `${where}: body is longer than ${MAX_CARD_BODY} characters` };
    if (needsReason(draft.status) && !draft.reason)
      return { ok: false, reason: `${where}: a ${draft.status} card needs a "reason"` };
    if (draft.reason !== undefined && draft.reason.length > MAX_CARD_REASON)
      return { ok: false, reason: `${where}: reason is longer than ${MAX_CARD_REASON} characters` };
    const runId = previous ? previous.runId : input.runId;
    return {
      ok: true,
      value: withMove(
        {
          id: draft.id,
          title: draft.title,
          body: draft.body,
          status: draft.status,
          ...(needsReason(draft.status) && draft.reason ? { reason: draft.reason } : {}),
          ...(draft.assigneeNodeId === undefined ? {} : { assigneeNodeId: draft.assigneeNodeId }),
          updatedBy: input.actor,
          updatedAt: input.at,
          ...(runId === undefined ? {} : { runId }),
        },
        previous,
      ),
    };
  };
  for (const [index, op] of input.ops.entries()) {
    const where = `kanban operation ${index}`;
    if (op.op === "delete") {
      if (!cards.delete(op.id)) return { ok: false, reason: `${where}: unknown card "${op.id}"` };
      upserted.delete(op.id);
      deleted.add(op.id);
      continue;
    }
    const assignee =
      op.assignee === undefined || op.assignee === null ? undefined : assign(op.assignee);
    if (assignee && !assignee.ok) return { ok: false, reason: `${where}: ${assignee.reason}` };
    if (op.op === "create") {
      const id = op.id ?? input.newId();
      if (cards.has(id)) return { ok: false, reason: `${where}: card "${id}" already exists` };
      const card = finish(
        {
          id,
          title: op.title,
          body: op.body ?? "",
          status: op.status ?? "todo",
          reason: op.reason,
          assigneeNodeId: assignee?.value,
        },
        where,
      );
      if (!card.ok) return card;
      cards.set(id, card.value);
      deleted.delete(id);
      upserted.add(id);
      continue;
    }
    const current = cards.get(op.id);
    if (!current) return { ok: false, reason: `${where}: unknown card "${op.id}"` };
    const status = op.status ?? current.status;
    const card = finish(
      {
        id: current.id,
        title: op.title ?? current.title,
        body: op.body ?? current.body,
        status,
        reason: op.reason ?? (status === current.status ? current.reason : undefined),
        assigneeNodeId:
          op.assignee === null ? undefined : (assignee?.value ?? current.assigneeNodeId),
      },
      where,
      current,
    );
    if (!card.ok) return card;
    cards.set(current.id, card.value);
    upserted.add(current.id);
  }
  return {
    ok: true,
    value: {
      cards: [...cards.values()],
      upserted: [...upserted].flatMap((id) => cards.get(id) ?? []),
      deleted: [...deleted],
    },
  };
}

/** The card the engine moves for a node: its oldest card that is not done (preferring `statuses`). */
export function cardOfNode(
  cards: ReadonlyArray<KanbanCard>,
  nodeId: string,
  statuses: ReadonlyArray<KanbanStatus>,
): KanbanCard | undefined {
  return cards.find((card) => card.assigneeNodeId === nodeId && statuses.includes(card.status));
}

/** An engine move; `reason` is kept only for `blocked`. */
export function moveCard(
  card: KanbanCard,
  status: KanbanStatus,
  at: string,
  reason?: string,
): KanbanCard {
  const { reason: _previous, ...rest } = card;
  return withMove(
    {
      ...rest,
      status,
      ...(status === "blocked" ? { reason: reason ?? "The agent could not finish." } : {}),
      updatedBy: "engine",
      updatedAt: at,
    },
    card,
  );
}

/**
 * What the orchestrator owes the kanban in a reply, checked on the cards as its reply leaves them:
 * every worker it hands work to has an open card, and a finished run leaves nothing in todo or doing.
 * Returns a reason for the correction message, or undefined when the kanban fits.
 */
export function kanbanDuty(input: {
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly requested: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly finishingRun: boolean;
}): string | undefined {
  const open = (card: KanbanCard) => card.status !== "done";
  const missing = input.requested.filter(
    (worker) => !input.cards.some((card) => card.assigneeNodeId === worker.id && open(card)),
  );
  if (missing.length > 0)
    return `kanban: every worker you give work to needs an open card (todo, doing or blocked) assigned to it; missing for ${missing.map((worker) => worker.name).join(", ")}. Add {"op":"create","title":"...","assignee":"<name>"} to "kanban".`;
  if (!input.finishingRun) return undefined;
  const unfinished = input.cards.filter(
    (card) => card.status === "todo" || card.status === "doing",
  );
  if (unfinished.length > 0)
    return `kanban: before you finish the run, move every card out of todo and doing (to done, or to blocked or waiting_for_human with a "reason"): ${unfinished.map((card) => `${card.id} "${card.title}"`).join(", ")}.`;
  return undefined;
}
