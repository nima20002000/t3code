import {
  CommandId,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef } from "react";

import { newMessageId, randomUUID } from "../lib/utils";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import {
  addPending,
  appendLog,
  areConnected,
  getBoardState,
  isProcessed,
  markProcessed,
  removePending,
  updateNode,
  useBoardState,
  type BoardNode,
} from "./boardStore";
import {
  buildResultMessage,
  buildTaskMessage,
  matchNodeName,
  parseWakeBlocks,
} from "./wakeProtocol";

type ThreadData = OrchestrationV2ThreadProjection;

interface NodeThreadInfo {
  readonly running: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

// Latest known thread mode and run state per node, filled by the watchers.
const nodeThreadInfo = new Map<string, NodeThreadInfo>();

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

type SendToNode = (node: BoardNode, text: string) => Promise<boolean>;

export function useSendToBoardNode(): SendToNode {
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const startRef = useRef(startThreadTurn);
  startRef.current = startThreadTurn;
  return useCallback(async (node, text) => {
    const info = nodeThreadInfo.get(node.id);
    if (!info) {
      appendLog("info", `Could not send to ${node.name}: thread is not loaded yet.`);
      return false;
    }
    const result = await startRef.current({
      environmentId: node.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        threadId: node.threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: info.runtimeMode,
        interactionMode: info.interactionMode,
        dispatchMode: info.running ? "queue" : "auto",
      },
    });
    if (result._tag === "Failure") {
      appendLog("info", `Sending to ${node.name} failed.`);
      return false;
    }
    return true;
  }, []);
}

function handleSettledThread(node: BoardNode, data: ThreadData, send: SendToNode) {
  const assistantMessages = data.messages.filter(
    (message) => message.role === "assistant" && !message.streaming,
  );
  if (node.awaitingFirstReply) {
    // Board-started agent: wait for the reply to its setup prompt, then skip it.
    if (assistantMessages.length === 0) return;
    markProcessed(assistantMessages.map((message) => message.id));
    updateNode(node.id, { awaitingFirstReply: false });
    return;
  }
  if (!node.baselined) {
    markProcessed(assistantMessages.map((message) => message.id));
    updateNode(node.id, { baselined: true });
    return;
  }
  const fresh = assistantMessages.filter((message) => !isProcessed(message.id));
  const latest = fresh.at(-1);
  if (!latest) return;
  markProcessed(fresh.map((message) => message.id));
  const text = latest.text;
  const board = getBoardState();

  // Pending wake targeting this node: its reply goes back to the requester.
  const pending = board.pending.find((wake) => wake.to === node.id);
  if (pending) {
    removePending(pending.id);
    const requester = board.nodes.find((candidate) => candidate.id === pending.from);
    if (requester) {
      void send(requester, buildResultMessage(node.name, text)).then((sent) => {
        if (sent) appendLog("result", `${node.name} -> ${requester.name}: result sent.`);
      });
    }
  }

  // Wake blocks in this reply go to connected nodes only.
  for (const request of parseWakeBlocks(text)) {
    const connected = board.nodes.filter(
      (candidate) => candidate.id !== node.id && areConnected(node.id, candidate.id),
    );
    const targetName = matchNodeName(
      connected.map((candidate) => candidate.name),
      request.node,
    );
    const target = connected.find((candidate) => candidate.name === targetName);
    if (!target) {
      appendLog("info", `${node.name} tried to wake "${request.node}", which is not connected.`);
      continue;
    }
    void send(target, buildTaskMessage(node.name, request.task)).then((sent) => {
      if (!sent) return;
      addPending({ id: randomUUID(), from: node.id, to: target.id });
      appendLog("wake", `${node.name} -> ${target.name}: ${request.task}`);
    });
  }
}

function NodeWatcher(props: { readonly node: BoardNode; readonly send: SendToNode }) {
  const { node, send } = props;
  const state = useEnvironmentThread(node.environmentId, node.threadId);
  const data = Option.getOrNull(state.data);
  const sendRef = useRef(send);
  sendRef.current = send;
  const nodeRef = useRef(node);
  nodeRef.current = node;

  useEffect(() => {
    if (data === null) return;
    const running = data.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
    nodeThreadInfo.set(nodeRef.current.id, {
      running,
      runtimeMode: data.thread.runtimeMode,
      interactionMode: data.thread.interactionMode,
    });
    if (running || state.status !== "live") return;
    handleSettledThread(nodeRef.current, data, sendRef.current);
  }, [data, state.status]);

  return null;
}

/** Mounted in the chat layout so board nodes keep working while the Board page is closed. */
export function BoardEngine() {
  const { nodes } = useBoardState();
  const send = useSendToBoardNode();
  return (
    <>
      {nodes.map((node) => (
        <NodeWatcher key={node.id} node={node} send={send} />
      ))}
    </>
  );
}
