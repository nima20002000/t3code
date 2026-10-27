/** Structured result envelope every board agent ends its turn with (simplified Foreman coordination result). */

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

  switch (routing.kind) {
    case "finish":
      return { ok: true, result: { summary, data, routing: { kind: "finish" } } };
    case "return": {
      const id = routing.requestId;
      if (id !== undefined && typeof id !== "string") {
        return { ok: false, reason: '"routing.requestId" must be a string' };
      }
      const requestId = typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
      return {
        ok: true,
        result: {
          summary,
          data,
          routing: requestId === undefined ? { kind: "return" } : { kind: "return", requestId },
        },
      };
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
      return { ok: true, result: { summary, data, routing: { kind: "request", requests } } };
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

/**
 * `outgoingNames` are the nodes this agent may send requests to (connectedNodeNames);
 * `incomingNames` are the nodes that may send requests to it.
 */
export function buildBoardInstructions(
  name: string,
  outgoingNames: ReadonlyArray<string>,
  incomingNames: ReadonlyArray<string> = [],
): string {
  return [
    `[Board] You are the agent "${name}" on a board with other agents. The board routes work between agents; it never reads your prose.`,
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
    'routing "finish" ends your work and routes nothing (use it when the task is complete and nobody asked you for it):',
    "```json",
    '{ "summary": "All done", "data": { "result": "..." }, "routing": { "kind": "finish" } }',
    "```",
    "",
    "Rules:",
    '- A message starting with "[Board] Work request" holds a requestId. You must eventually answer it with a "return" that echoes that requestId.',
    '- A message starting with "[Board] Work return" is the answer to a request you sent; use it, then continue (request more work, return, or finish).',
    '- A message starting with "[Board] Workflow run started" gives you the task of a run.',
    "- Request only agents listed below. Names are matched case-insensitively.",
    "- If your reply has no valid json block, the board asks you once to resend it.",
    "",
    "You can send requests to:",
    nameList(outgoingNames),
    "",
    "These agents may send requests to you:",
    nameList(incomingNames),
  ].join("\n");
}

/** First message of an agent the board starts: its role, then the board instructions. */
export function buildAgentFirstPrompt(
  name: string,
  role: string,
  outgoingNames: ReadonlyArray<string>,
  incomingNames: ReadonlyArray<string> = [],
): string {
  const instructions = buildBoardInstructions(name, outgoingNames, incomingNames);
  const trimmed = role.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${instructions}` : instructions;
}
