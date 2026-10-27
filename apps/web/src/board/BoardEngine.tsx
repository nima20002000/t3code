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
  activeRunOf,
  addPending,
  addRunRequest,
  appendLog,
  canRequest,
  clearRunRequest,
  endRun,
  findWorkflowOfNode,
  getWorkflow,
  isProcessed,
  markProcessed,
  removePending,
  startRun,
  stopWorkflowRun,
  updateNode,
  updateRunRequest,
  useWorkflows,
  type BoardNode,
  type Workflow,
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
} from "@t3tools/board-core/resultProtocol";

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

const BRIEFING_PREFIX = "[Board] You are the agent";
// Nodes whose last board message was a briefing: a `request` in the reply is not acted on outside a run.
const briefedNodes = new Set<string>();

export function useSendToBoardNode(): SendToNode {
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const startRef = useRef(startThreadTurn);
  startRef.current = startThreadTurn;
  return useCallback(async (node, text) => {
    if (text.startsWith(BRIEFING_PREFIX)) briefedNodes.add(node.id);
    else briefedNodes.delete(node.id);
    const info = nodeThreadInfo.get(node.id);
    if (!info) {
      appendLog(
        "info",
        `Could not send to ${node.name}: thread is not loaded yet.`,
        findWorkflowOfNode(node.id)?.id,
      );
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
      appendLog("info", `Sending to ${node.name} failed.`, findWorkflowOfNode(node.id)?.id);
      return false;
    }
    return true;
  }, []);
}

// Nodes that already got one correction message for their current invalid reply.
const correctedNodes = new Set<string>();
// Nodes interrupted by Stop while running: their cut-off reply must not be parsed or corrected.
const stoppedNodes = new Set<string>();

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildHandoffExhaustedMessage(targetName: string, limit: number): string {
  return `[Board] Work handoff limit reached: you may send at most ${limit} request(s) to ${targetName} per run and that is used up, so the request was not delivered. Do not send more requests to ${targetName}; continue with what you have and end your reply with a valid result block.`;
}

function handleInvalid(workflowId: string, node: BoardNode, reason: string, send: SendToNode) {
  if (correctedNodes.has(node.id)) {
    correctedNodes.delete(node.id);
    appendLog(
      "error",
      `${node.name}: still no valid result block (${reason}); giving up this turn.`,
      workflowId,
    );
    return;
  }
  correctedNodes.add(node.id);
  appendLog(
    "error",
    `${node.name}: invalid result (${reason}); asked for a correction.`,
    workflowId,
  );
  void send(node, buildCorrectionMessage(reason));
}

function routeReturn(
  workflow: Workflow,
  node: BoardNode,
  pendingId: string,
  result: BoardResult,
  send: SendToNode,
) {
  const pending = workflow.pending.find((entry) => entry.id === pendingId);
  if (!pending) return;
  removePending(workflow.id, pending.id);
  updateRunRequest(workflow.id, pending.id, {
    status: "returned",
    returnedAt: new Date().toISOString(),
    returnSummary: result.summary,
    returnData: result.data,
  });
  const requester = workflow.nodes.find((candidate) => candidate.id === pending.from);
  if (!requester) {
    appendLog("info", `${node.name} returned, but the requester no longer exists.`, workflow.id);
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
    if (sent) {
      appendLog(
        "result",
        `${node.name} -> ${requester.name}: ${truncate(result.summary)}`,
        workflow.id,
      );
    }
  });
}

function handleResult(
  workflowId: string,
  node: BoardNode,
  result: BoardResult,
  send: SendToNode,
): string | null {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return null;
  const incoming = workflow.pending.filter((entry) => entry.to === node.id);
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
      routeReturn(workflow, node, match, result, send);
      return null;
    }
    const run = activeRunOf(workflow);
    if (run && run.nodeId === node.id) {
      endRun(workflow.id, run.id, "finished", { summary: result.summary, data: result.data });
      appendLog(
        "run",
        `Run ${run.id.slice(0, 8)} finished by ${node.name}: ${result.summary} ${truncate(JSON.stringify(result.data), 400)}`,
        workflow.id,
      );
    } else {
      appendLog("info", `${node.name} finished: ${truncate(result.summary)}`, workflow.id);
    }
    return null;
  }

  // Validate every target first so a bad request sends nothing.
  const reachable = workflow.nodes.filter(
    (candidate) => candidate.id !== node.id && canRequest(node.id, candidate.id),
  );
  const targets: Array<{ target: BoardNode; request: WorkRequest }> = [];
  for (const request of routing.requests) {
    const name = matchNodeName(
      reachable.map((candidate) => candidate.name),
      request.to,
    );
    const target = reachable.find((candidate) => candidate.name === name);
    if (!target) return `"${request.to}" is not a node you can send requests to`;
    targets.push({ target, request });
  }

  const run = activeRunOf(workflow);
  const cap = workflow.settings.maxHandoffsPerEdge;
  const used = new Map<string, number>();
  const countUsed = (targetId: string) =>
    used.get(targetId) ??
    run?.requests.filter(
      (entry) => entry.fromId === node.id && entry.toId === targetId && entry.status !== "denied",
    ).length ??
    0;
  const exhausted = new Set<string>();

  for (const { target, request } of targets) {
    const requestId = randomUUID();
    const record = {
      id: requestId,
      fromId: node.id,
      toId: target.id,
      from: node.name,
      to: target.name,
      at: new Date().toISOString(),
      task: request.task,
      input: request.input,
    };
    if (cap !== null && countUsed(target.id) >= cap) {
      exhausted.add(target.name);
      if (run) addRunRequest(workflow.id, run.id, { ...record, status: "denied" });
      appendLog(
        "info",
        `${node.name} -> ${target.name} denied: handoff limit (${cap}) reached.`,
        workflow.id,
      );
      continue;
    }
    used.set(target.id, countUsed(target.id) + 1);
    if (run) addRunRequest(workflow.id, run.id, { ...record, status: "pending" });
    addPending(workflow.id, { id: requestId, from: node.id, to: target.id });
    void send(
      target,
      buildRequestMessage({ requestId, from: node.name, task: request.task, input: request.input }),
    ).then((sent) => {
      if (sent) {
        appendLog("wake", `${node.name} -> ${target.name}: ${truncate(request.task)}`, workflow.id);
      } else {
        removePending(workflow.id, requestId);
        updateRunRequest(workflow.id, requestId, { status: "dropped" });
      }
    });
  }
  if (cap !== null) {
    for (const targetName of exhausted) {
      void send(node, buildHandoffExhaustedMessage(targetName, cap));
    }
  }
  return null;
}

function handleSettledThread(
  workflowId: string,
  node: BoardNode,
  data: ThreadData,
  send: SendToNode,
) {
  const assistantMessages = data.messages.filter(
    (message) => message.role === "assistant" && !message.streaming,
  );
  if (stoppedNodes.delete(node.id)) {
    markProcessed(assistantMessages.map((message) => message.id));
    return;
  }
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
    handleInvalid(workflowId, node, parsed.reason, send);
    return;
  }
  const currentWorkflow = getWorkflow(workflowId);
  if (
    briefedNodes.delete(node.id) &&
    parsed.result.routing.kind === "request" &&
    !(currentWorkflow && activeRunOf(currentWorkflow))
  ) {
    appendLog(
      "info",
      `${node.name} answered a briefing with a request; ignored: ${truncate(parsed.result.summary)}`,
      workflowId,
    );
    return;
  }
  const problem = handleResult(workflowId, node, parsed.result, send);
  if (problem) {
    handleInvalid(workflowId, node, problem, send);
    return;
  }
  correctedNodes.delete(node.id);
}

function NodeWatcher(props: {
  readonly workflowId: string;
  readonly node: BoardNode;
  readonly send: SendToNode;
}) {
  const { workflowId, node, send } = props;
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
    handleSettledThread(workflowId, nodeRef.current, data, sendRef.current);
  }, [data, state.status, workflowId]);

  return null;
}

/**
 * Stop for one workflow: marks the run stopped and drops its pending requests, then interrupts
 * every node thread with t3's interrupt-turn command (the thread view's stop button).
 */
export function useStopWorkflow(): (workflowId: string) => Promise<void> {
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const interruptRef = useRef(interruptTurn);
  interruptRef.current = interruptTurn;
  return useCallback(async (workflowId) => {
    const workflow = getWorkflow(workflowId);
    if (!workflow) return;
    for (const node of workflow.nodes) {
      if (nodeThreadInfo.get(node.id)?.running) stoppedNodes.add(node.id);
      correctedNodes.delete(node.id);
    }
    stopWorkflowRun(workflowId);
    appendLog("run", "Run stopped: interrupting every agent.", workflowId);
    const results = await Promise.all(
      workflow.nodes.map((node) =>
        interruptRef.current({
          environmentId: node.environmentId,
          input: { threadId: node.threadId },
        }),
      ),
    );
    const failed = results.filter((result) => result._tag === "Failure").length;
    if (failed > 0) appendLog("error", `${failed} agent(s) could not be interrupted.`, workflowId);
  }, []);
}

/** Mounted in the chat layout so board nodes keep working while the Board page is closed. */
export function BoardEngine() {
  const workflows = useWorkflows();
  const send = useSendToBoardNode();
  const sendRef = useRef(send);
  sendRef.current = send;
  const startedRuns = useRef(new Set<string>());

  useEffect(() => {
    for (const workflow of workflows) {
      for (const run of workflow.runQueue) {
        if (startedRuns.current.has(run.id)) continue;
        startedRuns.current.add(run.id);
        const workflowId = workflow.id;
        const node = getWorkflow(workflowId)?.nodes.find(
          (candidate) => candidate.id === run.nodeId,
        );
        if (!node) {
          appendLog("error", "Run skipped: the entry node no longer exists.", workflowId);
          clearRunRequest(workflowId, run.id);
          continue;
        }
        const current = getWorkflow(workflowId);
        if (current && activeRunOf(current)) {
          appendLog("error", "Run skipped: a run is already active.", workflowId);
          clearRunRequest(workflowId, run.id);
          continue;
        }
        startRun(workflowId, { id: run.id, nodeId: node.id, nodeName: node.name, task: run.task });
        void sendRef.current(node, buildStartMessage(run.id, run.task)).then((sent) => {
          if (sent) {
            appendLog("run", `Run ${run.id.slice(0, 8)} started at ${node.name}.`, workflowId);
          } else {
            endRun(workflowId, run.id, "failed", { summary: `Could not start at ${node.name}.` });
            appendLog("error", `Run could not start at ${node.name}.`, workflowId);
          }
          clearRunRequest(workflowId, run.id);
        });
      }
    }
  }, [workflows]);
  return (
    <>
      {workflows.flatMap((workflow) =>
        workflow.nodes.map((node) => (
          <NodeWatcher key={node.id} workflowId={workflow.id} node={node} send={send} />
        )),
      )}
    </>
  );
}
