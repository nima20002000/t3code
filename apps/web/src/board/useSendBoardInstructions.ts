import { CommandId } from "@t3tools/contracts";
import type { BoardNode } from "./boardStore";
import {
  newMessageId,
  randomUUID,
  readThreadShells,
  threadEnvironment,
  toastManager,
  useOrchestrationCommand,
} from "./upstream";

export function useSendBoardInstructions() {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return async (node: BoardNode, text: string) => {
    const thread = readThreadShells().find(
      (item) => item.environmentId === node.environmentId && item.id === node.threadId,
    );
    if (!thread) {
      toastManager.add({
        type: "error",
        title: "Thread is not connected",
        description: "Connect this machine to send board instructions.",
      });
      return false;
    }
    const result = await startTurn({
      environmentId: node.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        threadId: node.threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        dispatchMode: "queue",
      },
    });
    if (result._tag === "Failure")
      toastManager.add({ type: "error", title: "Could not send board instructions" });
    return result._tag !== "Failure";
  };
}
