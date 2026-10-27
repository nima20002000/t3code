/** Structured result envelope every board agent ends its turn with (simplified Foreman coordination result). */

import type { AgentProfile } from "./boardModel.ts";
import { parseKanbanOps, type KanbanCard, type KanbanOp } from "./kanban.ts";

export interface WorkRequest {
  readonly to: string;
  readonly task: string;
  readonly input?: unknown;
}

export type Routing =
  | { readonly kind: "request"; readonly requests: ReadonlyArray<WorkRequest> }
  | { readonly kind: "return"; readonly requestId?: string }
  | { readonly kind: "finish" };

export interface BoardResult {
  readonly summary: string;
  readonly data: unknown;
  readonly routing: Routing;
  /** Kanban operations; only the orchestrator's are applied. */
  readonly kanban?: ReadonlyArray<KanbanOp>;
}

export type ParseResult =
  | { readonly ok: true; readonly result: BoardResult }
  | { readonly ok: false; readonly reason: string };

export const MAX_SUMMARY_LENGTH = 600;

const FENCE = /```json[^\S\n]*\n([\s\S]*?)```/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and validates the LAST fenced json block of an assistant message. */
export function parseResult(text: string): ParseResult {
  const blocks = [...text.matchAll(FENCE)];
  const last = blocks.at(-1);
  if (!last) return { ok: false, reason: "no json block found" };
  let raw: unknown;
  try {
    raw = JSON.parse(last[1] ?? "");
  } catch {
    return { ok: false, reason: "the last json block is not valid JSON" };
  }
  if (!isRecord(raw)) return { ok: false, reason: "the json block must be an object" };

  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (summary.length === 0) return { ok: false, reason: '"summary" is required' };
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, reason: `"summary" must be at most ${MAX_SUMMARY_LENGTH} characters` };
  }

  const routing = raw.routing;
  if (!isRecord(routing)) return { ok: false, reason: '"routing" is required' };
  const data = raw.data === undefined ? null : raw.data;
  let kanban: ReadonlyArray<KanbanOp> = [];
  if (raw.kanban !== undefined && raw.kanban !== null) {
    const parsed = parseKanbanOps(raw.kanban);
    if (!parsed.ok) return parsed;
    kanban = parsed.value;
  }
  const done = (result: Omit<BoardResult, "kanban">): ParseResult => ({
    ok: true,
    result: kanban.length > 0 ? { ...result, kanban } : result,
  });

  switch (routing.kind) {
    case "finish":
      return done({ summary, data, routing: { kind: "finish" } });
    case "return": {
      const id = routing.requestId;
      if (id !== undefined && typeof id !== "string") {
        return { ok: false, reason: '"routing.requestId" must be a string' };
      }
      const requestId = typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
      return done({
        summary,
        data,
        routing: requestId === undefined ? { kind: "return" } : { kind: "return", requestId },
      });
    }
    case "request": {
      const list = routing.requests;
      if (!Array.isArray(list) || list.length === 0) {
        return { ok: false, reason: '"routing.requests" must be a non-empty array' };
      }
      const requests: WorkRequest[] = [];
      for (const [index, item] of list.entries()) {
        if (!isRecord(item)) return { ok: false, reason: `request ${index} must be an object` };
        const to = typeof item.to === "string" ? item.to.trim() : "";
        const task = typeof item.task === "string" ? item.task.trim() : "";
        if (to.length === 0) return { ok: false, reason: `request ${index} needs a "to" name` };
        if (task.length === 0) return { ok: false, reason: `request ${index} needs a "task"` };
        requests.push(item.input === undefined ? { to, task } : { to, task, input: item.input });
      }
      return done({ summary, data, routing: { kind: "request", requests } });
    }
    default:
      return {
        ok: false,
        reason: '"routing.kind" must be "request", "return" or "finish"',
      };
  }
}

/** Finds a name in `names` ignoring case and surrounding whitespace. */
export function matchNodeName(names: ReadonlyArray<string>, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  return names.find((candidate) => candidate.trim().toLowerCase() === wanted) ?? null;
}

function jsonBlock(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

export function buildRequestMessage(input: {
  readonly requestId: string;
  readonly from: string;
  readonly task: string;
  readonly input?: unknown;
}): string {
  const body: Record<string, unknown> = {
    board: "request",
    requestId: input.requestId,
    from: input.from,
    task: input.task,
  };
  if (input.input !== undefined) body.input = input.input;
  return [
    "[Board] Work request",
    "",
    jsonBlock(body),
    "",
    `When done, end your reply with a result block whose routing is {"kind":"return","requestId":"${input.requestId}"}.`,
  ].join("\n");
}

export function buildReturnMessage(input: {
  readonly requestId: string;
  readonly from: string;
  readonly summary: string;
  readonly data: unknown;
}): string {
  return [
    "[Board] Work return",
    "",
    jsonBlock({
      board: "return",
      requestId: input.requestId,
      from: input.from,
      summary: input.summary,
      data: input.data,
    }),
  ].join("\n");
}

export function buildStartMessage(runId: string, task: string): string {
  return ["[Board] Workflow run started", "", jsonBlock({ board: "start", runId, task })].join(
    "\n",
  );
}

/** The current cards as one compact block, so the orchestrator knows the ids the board generated. */
export function buildKanbanBrief(
  cards: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string }>,
): string {
  if (cards.length === 0) return "";
  return [
    "[Board] Current kanban cards",
    "",
    jsonBlock(cards.map(({ id, title, status }) => ({ id, title, status }))),
  ].join("\n");
}

export function buildCorrectionMessage(reason: string): string {
  return `[Board] Your last reply had no valid result block: ${reason}. Reply again ending with a valid json block.`;
}

/** Names of the nodes `nodeId` may send requests to (outgoing edges), in edge order. */
export function connectedNodeNames(
  nodes: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  edges: ReadonlyArray<{ readonly a: string; readonly b: string }>,
  nodeId: string,
): ReadonlyArray<string> {
  return edges.flatMap((edge) => {
    const peer = edge.a === nodeId ? nodes.find((node) => node.id === edge.b) : undefined;
    return peer ? [peer.name] : [];
  });
}

/** Names of the nodes that may send requests to `nodeId` (incoming edges), in edge order. */
export function incomingNodeNames(
  nodes: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  edges: ReadonlyArray<{ readonly a: string; readonly b: string }>,
  nodeId: string,
): ReadonlyArray<string> {
  return edges.flatMap((edge) => {
    const peer = edge.b === nodeId ? nodes.find((node) => node.id === edge.a) : undefined;
    return peer ? [peer.name] : [];
  });
}

function nameList(names: ReadonlyArray<string>): string {
  return names.length > 0 ? names.map((peer) => `- ${peer}`).join("\n") : "- (none)";
}

const PROFILE_ROLE: Record<AgentProfile, string> = {
  worker:
    "You are a worker. An orchestrator hands you work and checks your result. Do the work you are given, then finish: your summary and data go back to the orchestrator that asked.",
  orchestrator:
    "You are the orchestrator. You hand out work to your workers, check what they send back, and finish when the whole task is done.",
};

const PROFILE_RULES: Record<AgentProfile, ReadonlyArray<string>> = {
  worker: [
    '- Finish a work request with routing {"kind":"finish"} (not "return"): your summary and data go back to the agent that asked, automatically. Put the complete deliverable in "data".',
    "- You get only what the request holds, so ask for nothing from the owner and never expect another agent to relay for you.",
    '- The workflow kanban is kept by the orchestrator. Never add a "kanban" field.',
  ],
  orchestrator: [
    '- Give work with routing "request": one request per worker, with the complete task (the worker sees only what you send). Several requests run in parallel.',
    '- Each worker\'s result comes back as a "[Board] Work return" message. Check it. If it is not good enough, request that worker again saying what to fix; otherwise move on.',
    '- Finish with routing {"kind":"finish"} only when the whole task is done. Put the final deliverable in "data"; anything still open belongs in the summary.',
    "- You keep the workflow kanban (see below). Keep it current: a card for each piece of work you hand out, assigned to the worker.",
  ],
};

function kanbanSection(
  cards: ReadonlyArray<KanbanCard>,
  nodeNames: ReadonlyArray<string>,
): string[] {
  const rows =
    cards.length === 0
      ? ["(no cards yet)"]
      : cards.slice(-50).map((card) => {
          const detail = card.reason ? ` (${card.reason})` : "";
          return `- ${card.id} [${card.status}] ${card.title}${detail}`;
        });
  return [
    "",
    'Kanban. Add a top-level "kanban" array to your result to change it. Operations:',
    "```json",
    '[ {"op":"create","title":"Write the parser","body":"details","status":"todo","assignee":"<node name>"},',
    '  {"op":"update","id":"<card id>","status":"blocked","reason":"why"},',
    '  {"op":"delete","id":"<card id>"} ]',
    "```",
    'Statuses: todo, doing, blocked, done. "blocked" needs a "reason". The board moves a worker\'s card to doing when you give it work and to done or blocked when its result comes back; you correct the rest.',
    `Assignees: ${nodeNames.join(", ") || "(none)"}.`,
    "Current cards:",
    ...rows,
  ];
}

/**
 * What a node's thread is seeded with on its first work in a run: profile role (or the node's own
 * prompt), the result protocol, and its connections. `kanban` is shown to the orchestrator only.
 */
export function buildAgentInstructions(input: {
  readonly name: string;
  readonly profile: AgentProfile;
  readonly prompt?: string | undefined;
  readonly outgoing: ReadonlyArray<string>;
  readonly incoming: ReadonlyArray<string>;
  readonly kanban?: ReadonlyArray<KanbanCard> | undefined;
  readonly nodeNames?: ReadonlyArray<string> | undefined;
}): string {
  const prompt = input.prompt?.trim() ?? "";
  return [
    `[Board] You are the agent "${input.name}" on a board with other agents. The board routes work between agents; it never reads your prose.`,
    "",
    prompt.length > 0 ? prompt : PROFILE_ROLE[input.profile],
    "",
    "Every reply you write MUST end with exactly one fenced json block, the result envelope. The board reads only the LAST json block of your final message:",
    "",
    "```json",
    "{",
    '  "summary": "one-line summary (required, at most 600 characters)",',
    '  "data": "any JSON: your deliverable",',
    '  "routing": { "kind": "request" | "return" | "finish", ... }',
    "}",
    "```",
    "",
    'routing "request" asks other agents for work. Several requests run in parallel:',
    "```json",
    '{ "summary": "Asked QA to test", "data": null, "routing": { "kind": "request", "requests": [ { "to": "QA", "task": "Run the tests", "input": { "branch": "main" } } ] } }',
    "```",
    "",
    'routing "return" answers a work request you received. Echo the requestId you were given:',
    "```json",
    '{ "summary": "Tests pass", "data": { "passed": 42 }, "routing": { "kind": "return", "requestId": "<requestId from the request>" } }',
    "```",
    "",
    'routing "finish" ends your work. It answers the request you were given, or ends the run when you were given the run task:',
    "```json",
    '{ "summary": "All done", "data": { "result": "..." }, "routing": { "kind": "finish" } }',
    "```",
    "",
    "Rules:",
    ...PROFILE_RULES[input.profile],
    '- A message starting with "[Board] Work request" holds a requestId. Answer it with "finish" or a "return" that echoes that requestId.',
    '- A message starting with "[Board] Work return" is the answer to a request you sent; use it, then continue (request more work or finish).',
    '- A message starting with "[Board] Workflow run started" gives you the task of a run.',
    "- Act only on a board message or on direct user chat. After an interruption (for example a stopped run) never start new requests on your own or resume old work.",
    "- Request only agents listed below. Names are matched case-insensitively.",
    "- If your reply has no valid json block, the board asks you once to resend it.",
    "",
    "You can send requests to:",
    nameList(input.outgoing),
    "",
    "These agents may send requests to you:",
    nameList(input.incoming),
    ...(input.profile === "orchestrator"
      ? kanbanSection(input.kanban ?? [], input.nodeNames ?? [])
      : []),
  ].join("\n");
}

/** The first message a node's fresh thread gets: its instructions, then the work that started it. */
export function buildSeededMessage(instructions: string, work: string): string {
  return `${instructions}\n\n---\n\n${work}`;
}
