import { createNode, getCurrentWorkflow, removeNode, type BoardNode } from "./boardStore";
import { randomUUID } from "./upstream";

const PASTE_OFFSET = 40;

/** Copied agents wait here until pasted; it survives switching workflows. */
let clipboard: ReadonlyArray<BoardNode> = [];
let pasteCount = 0;

export function copyNodes(nodes: ReadonlyArray<BoardNode>) {
  if (nodes.length === 0) return;
  clipboard = nodes;
  pasteCount = 0;
}

export function hasCopiedNodes() {
  return clipboard.length > 0;
}

async function clone(nodes: ReadonlyArray<BoardNode>, offset: number) {
  const workflowId = getCurrentWorkflow().id;
  for (const node of nodes) {
    await createNode(workflowId, {
      id: randomUUID(),
      name: `${node.name} copy`,
      // A workflow has one orchestrator, so its copies are workers.
      profile: "worker",
      environmentId: node.environmentId,
      modelSelection: node.modelSelection,
      ...(node.prompt === undefined ? {} : { prompt: node.prompt }),
      ...(node.runtimeMode === undefined ? {} : { runtimeMode: node.runtimeMode }),
      ...(node.profile === "worker" && node.size !== undefined ? { size: node.size } : {}),
      x: node.x + offset,
      y: node.y + offset,
    });
  }
}

export function pasteNodes() {
  pasteCount += 1;
  return clone(clipboard, PASTE_OFFSET * pasteCount);
}

export function duplicateNodes(nodes: ReadonlyArray<BoardNode>) {
  return clone(nodes, PASTE_OFFSET);
}

export function deleteNodes(nodes: ReadonlyArray<BoardNode>) {
  for (const node of nodes) removeNode(node.id);
}
