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
  canRequest,
  clearRunRequest,
  getBoardState,
  isProcessed,
  markProcessed,
  removePending,
  updateNode,
  useBoardState,
  type BoardNode,
} from "./boardStore";
import {
  buildCorrectionMessage,
  buildRequestMessage,
  buildReturnMessage,
  buildStartMessage,
  matchNodeName,
  parseResult,
  type BoardResult,
  type WorkRequest,
} from "./resultProtocol";

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

// Run id per entry node, so its `finish` can be logged as the end of the run (in memory, MVP).
const runByEntryNode = new Map<string, string>();
// Nodes that already got one correction message for their current invalid reply.
const correctedNodes = new Set<string>();

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function handleInvalid(node: BoardNode, reason: string, send: SendToNode) {
  if (correctedNodes.has(node.id)) {
    correctedNodes.delete(node.id);
    appendLog(
      "error",
      `${node.name}: still no valid result block (${reason}); giving up this turn.`,
    );
    return;
  }
  correctedNodes.add(node.id);
  appendLog("error", `${node.name}: invalid result (${reason}); asked for a correction.`);
  void send(node, buildCorrectionMessage(reason));
}

function routeReturn(node: BoardNode, pendingId: string, result: BoardResult, send: SendToNode) {
  const board = getBoardState();
  const pending = board.pending.find((entry) => entry.id === pendingId);
  if (!pending) return;
  removePending(pending.id);
  const requester = board.nodes.find((candidate) => candidate.id === pending.from);
  if (!requester) {
    appendLog("info", `${node.name} returned, but the requester no longer exists.`);
    return;
  }
  void send(
    requester,
    buildReturnMessage({
      requestId: pending.id,
      from: node.name,
      summary: result.summary,
      data: result.data,
    }),
  ).then((sent) => {
    if (sent) appendLog("result", `${node.name} -> ${requester.name}: ${truncate(result.summary)}`);
  });
}

function handleResult(node: BoardNode, result: BoardResult, send: SendToNode): string | null {
  const board = getBoardState();
  const incoming = board.pending.filter((entry) => entry.to === node.id);
  const { routing } = result;

  if (routing.kind === "return" || routing.kind === "finish") {
    let match: string | undefined;
    if (routing.kind === "return" && routing.requestId !== undefined) {
      match = incoming.find((entry) => entry.id === routing.requestId)?.id;
      if (!match) return `unknown requestId "${routing.requestId}" for ${node.name}`;
    } else if (incoming.length === 1) {
      // Lenient: a single pending request answered with `finish` or without an id.
      match = incoming[0]?.id;
    } else if (routing.kind === "return") {
      return incoming.length === 0
        ? "you have no pending request to return"
        : "requestId is required because several requests are pending";
    }
    if (match) {
      routeReturn(node, match, result, send);
      return null;
    }
    const runId = runByEntryNode.get(node.id);
    if (runId) {
      runByEntryNode.delete(node.id);
      appendLog(
        "run",
        `Run ${runId.slice(0, 8)} finished by ${node.name}: ${result.summary} ${truncate(JSON.stringify(result.data), 400)}`,
      );
    } else {
      appendLog("info", `${node.name} finished: ${truncate(result.summary)}`);
    }
    return null;
  }

  // Validate every target first so a bad request sends nothing.
  const targets: Array<{ target: BoardNode; request: WorkRequest }> = [];
  for (const request of routing.requests) {
    const reachable = board.nodes.filter(
      (candidate) => candidate.id !== node.id && canRequest(node.id, candidate.id),
    );
    const name = matchNodeName(
      reachable.map((candidate) => candidate.name),
      request.to,
    );
    const target = reachable.find((candidate) => candidate.name === name);
    if (!target) return `"${request.to}" is not a node you can send requests to`;
    targets.push({ target, request });
  }
  for (const { target, request } of targets) {
    const requestId = randomUUID();
    addPending({ id: requestId, from: node.id, to: target.id });
    void send(
      target,
      buildRequestMessage({ requestId, from: node.name, task: request.task, input: request.input }),
    ).then((sent) => {
      if (sent) appendLog("wake", `${node.name} -> ${target.name}: ${truncate(request.task)}`);
      else removePending(requestId);
    });
  }
  return null;
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

  const parsed = parseResult(latest.text);
  if (!parsed.ok) {
    handleInvalid(node, parsed.reason, send);
    return;
  }
  const problem = handleResult(node, parsed.result, send);
  if (problem) {
    handleInvalid(node, problem, send);
    return;
  }
  correctedNodes.delete(node.id);
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
  const { nodes, runQueue } = useBoardState();
  const send = useSendToBoardNode();
  const sendRef = useRef(send);
  sendRef.current = send;
  const startedRuns = useRef(new Set<string>());

  useEffect(() => {
    for (const run of runQueue) {
      if (startedRuns.current.has(run.id)) continue;
      startedRuns.current.add(run.id);
      const node = getBoardState().nodes.find((candidate) => candidate.id === run.nodeId);
      if (!node) {
        appendLog("error", "Run skipped: the entry node no longer exists.");
        clearRunRequest(run.id);
        continue;
      }
      runByEntryNode.set(node.id, run.id);
      void sendRef.current(node, buildStartMessage(run.id, run.task)).then((sent) => {
        appendLog(
          sent ? "run" : "error",
          sent
            ? `Run ${run.id.slice(0, 8)} started at ${node.name}.`
            : `Run could not start at ${node.name}.`,
        );
        if (!sent) runByEntryNode.delete(node.id);
        clearRunRequest(run.id);
      });
    }
  }, [runQueue]);
  return (
    <>
      {nodes.map((node) => (
        <NodeWatcher key={node.id} node={node} send={send} />
      ))}
    </>
  );
}
