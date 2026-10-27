export interface WakeRequest {
  readonly node: string;
  readonly task: string;
}

const WAKE_BLOCK = /<wake\s+node\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/wake>/gi;

/** Extracts every `<wake node="Name">task</wake>` block, in order. Empty names or tasks are skipped. */
export function parseWakeBlocks(text: string): ReadonlyArray<WakeRequest> {
  const requests: WakeRequest[] = [];
  for (const match of text.matchAll(WAKE_BLOCK)) {
    const node = (match[1] ?? "").trim();
    const task = (match[2] ?? "").trim();
    if (node.length === 0 || task.length === 0) continue;
    requests.push({ node, task });
  }
  return requests;
}

/** Finds a name in `names` ignoring case and surrounding whitespace. */
export function matchNodeName(names: ReadonlyArray<string>, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  return names.find((candidate) => candidate.trim().toLowerCase() === wanted) ?? null;
}

export function buildBoardInstructions(name: string, connectedNames: ReadonlyArray<string>): string {
  const peers =
    connectedNames.length > 0 ? connectedNames.map((peer) => `- ${peer}`).join("\n") : "(none yet)";
  return [
    `[Board] You are the agent "${name}" on a board with other agents.`,
    "",
    "To wake a connected agent, write a wake block in your reply:",
    "",
    '<wake node="NodeName">',
    "task text",
    "</wake>",
    "",
    "You may write several wake blocks in one reply. The board forwards each task to that agent. When it finishes its turn, the board sends its final reply back to you.",
    "Only the agents below are connected to you:",
    peers,
  ].join("\n");
}

export function buildTaskMessage(from: string, task: string): string {
  return `[Board] Task from ${from}:\n\n${task}\n\nYour final reply will be sent back to ${from}.`;
}

export function buildResultMessage(from: string, text: string): string {
  return `[Board] Result from ${from}:\n\n${text}`;
}
