import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { MessageSquareIcon, SettingsIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { useThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { NodeSettingsPanel } from "./NodeSettingsPanel";
import { AddAgentDialog } from "./AddAgentDialog";
import { useSendToBoardNode } from "./BoardEngine";
import {
  addEdge,
  addNode,
  appendLog,
  getCurrentWorkflow,
  isThreadOnBoard,
  recordHistoryStep,
  removeEdge,
  removeNode,
  updateNode,
  useCurrentWorkflow,
  type BoardNode,
} from "./boardStore";
import { AgentHandles } from "./foreman/AgentHandles";
import { AgentNodeView, type AgentNodeAction } from "./foreman/AgentNodeView";
import { SignalEdgeShape } from "./foreman/SignalEdgeShape";
import { AGENT_NODE_SIZE, useFloatingCurve } from "./foreman/signalEdge";
import "./foreman/foreman.css";
import { buildBoardInstructions, connectedNodeNames, incomingNodeNames } from "./resultProtocol";
import { BoardToolbar } from "./BoardToolbar";
import { BoardKanban } from "./toolbar/BoardKanban";
import { RunDetails } from "./toolbar/RunDetails";

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

function AddNodeForm({ onDone }: { onDone: () => void }) {
  const environments = useEnvironmentIdentities();
  const connectedIds = useConnectedEnvironmentIds();
  const threads = useThreadShells();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | "">("");
  const [threadId, setThreadId] = useState<ThreadId | "">("");
  const [name, setName] = useState("");
  const connected = environments.filter((environment) =>
    connectedIds.includes(environment.environmentId),
  );
  const environmentThreads = threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      !isThreadOnBoard(thread.environmentId, thread.id),
  );
  const environmentLabel =
    connected.find((env) => env.environmentId === environmentId)?.label ?? "";

  const submit = () => {
    if (environmentId === "" || threadId === "") return;
    addNode({ name: name.trim() || environmentLabel || "Agent", environmentId, threadId });
    onDone();
  };

  return (
    <div className="board-popover" role="dialog" aria-label="Add existing thread">
      <label>
        Machine
        <select
          value={environmentId}
          onChange={(event) => {
            setEnvironmentId(event.target.value as EnvironmentId | "");
            setThreadId("");
          }}
        >
          <option value="">Select...</option>
          {connected.map((environment) => (
            <option key={environment.environmentId} value={environment.environmentId}>
              {environment.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Thread
        <select
          value={threadId}
          onChange={(event) => setThreadId(event.target.value as ThreadId | "")}
        >
          <option value="">Select...</option>
          {environmentThreads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input
          className="h-8 rounded-md border bg-background px-2 text-sm font-normal text-foreground"
          placeholder={environmentLabel || "Agent name"}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={threadId === ""} onClick={submit}>
          Add node
        </Button>
      </div>
    </div>
  );
}

const OpenSettingsContext = createContext<(nodeId: string) => void>(() => {});

type AgentFlowNode = Node<{ readonly node: BoardNode }, "agent">;

function harnessOf(instanceId: string): "codex" | "claude" | "neutral" {
  const id = instanceId.toLowerCase();
  return id.includes("codex") ? "codex" : id.includes("claude") ? "claude" : "neutral";
}

function AgentCard({ data, selected }: NodeProps<AgentFlowNode>) {
  const { node } = data;
  const navigate = useNavigate();
  const connectedIds = useConnectedEnvironmentIds();
  const environments = useEnvironmentIdentities();
  const threads = useThreadShells();
  const openSettings = useContext(OpenSettingsContext);

  const shell = threads.find(
    (thread) => thread.environmentId === node.environmentId && thread.id === node.threadId,
  );
  const machine =
    environments.find((environment) => environment.environmentId === node.environmentId)?.label ??
    "Unknown";
  const status = !connectedIds.includes(node.environmentId)
    ? "disconnected"
    : shell && ACTIVE_STATUSES.has(shell.source.status)
      ? "working"
      : "idle";
  const instanceId = shell ? String(shell.modelSelection.instanceId) : "";

  const actions: AgentNodeAction[] = [
    {
      slot: "chat",
      label: `Open ${node.name} thread`,
      icon: <MessageSquareIcon size={15} />,
      onClick: () =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(node.environmentId, node.threadId)),
        }),
    },
    {
      slot: "settings",
      label: `${node.name} settings`,
      icon: <SettingsIcon size={15} />,
      onClick: () => openSettings(node.id),
    },
  ];

  return (
    <AgentNodeView
      name={node.name}
      harness={harnessOf(instanceId)}
      harnessLabel={shell ? instanceId : "Thread not found"}
      model={shell?.modelSelection.model ?? null}
      machine={machine}
      statusLabel={status === "working" ? "Working" : status === "idle" ? "Idle" : "Disconnected"}
      state={status === "working" ? "running" : status === "disconnected" ? "unavailable" : "idle"}
      selected={selected}
      actions={actions}
    >
      <AgentHandles name={node.name} />
    </AgentNodeView>
  );
}

function SignalEdge({ id, source, target }: EdgeProps) {
  const curve = useFloatingCurve(source, target);
  return curve ? <SignalEdgeShape id={id} curve={curve} /> : null;
}

const NODE_TYPES = { agent: AgentCard };
const EDGE_TYPES = { signal: SignalEdge };

function toFlowNode(node: BoardNode, previous?: AgentFlowNode): AgentFlowNode {
  return previous
    ? { ...previous, position: { x: node.x, y: node.y }, data: { node } }
    : {
        id: node.id,
        type: "agent",
        position: { x: node.x, y: node.y },
        width: AGENT_NODE_SIZE,
        height: AGENT_NODE_SIZE,
        data: { node },
      };
}

/** Keyed by workflow id so switching workflows resets the canvas, its selection and the fit. */
export function BoardPage() {
  const { id } = useCurrentWorkflow();
  return <BoardCanvasPage key={id} />;
}

function BoardCanvasPage() {
  const workflow = useCurrentWorkflow();
  const { nodes, edges } = workflow;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [kanban, setKanban] = useState(false);
  const selectedRun = workflow.runs.find((run) => run.id === selectedRunId) ?? null;
  const send = useSendToBoardNode();
  const [flowNodes, setFlowNodes] = useState<AgentFlowNode[]>(() =>
    nodes.map((n) => toFlowNode(n)),
  );
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const [addingAgent, setAddingAgent] = useState(false);
  const [addingThread, setAddingThread] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [settingsNodeId, setSettingsNodeId] = useState<string | null>(null);
  const settingsNode = nodes.find((n) => n.id === settingsNodeId) ?? null;

  // Store -> canvas: keep React Flow's own state (size, selection) for nodes that already exist.
  useEffect(() => {
    setFlowNodes((previous) =>
      nodes.map((node) =>
        toFlowNode(
          node,
          previous.find((candidate) => candidate.id === node.id),
        ),
      ),
    );
  }, [nodes]);

  const flowEdges: Edge[] = edges.map((edge) => {
    const id = `${edge.a}:${edge.b}`;
    return {
      id,
      type: "signal",
      source: edge.a,
      target: edge.b,
      sourceHandle: "right",
      targetHandle: "left",
      selected: selectedEdgeIds.has(id),
    };
  });

  // Canvas -> store: positions and deletions.
  const onNodesChange = (changes: NodeChange<AgentFlowNode>[]) => {
    setFlowNodes((previous) => applyNodeChanges(changes, previous));
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        updateNode(change.id, { x: change.position.x, y: change.position.y });
      } else if (change.type === "remove") {
        removeNode(change.id);
      }
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === "select") {
        setSelectedEdgeIds((previous) => {
          const next = new Set(previous);
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
          return next;
        });
      } else if (change.type === "remove") {
        const edge = getCurrentWorkflow().edges.find(
          (candidate) => `${candidate.a}:${candidate.b}` === change.id,
        );
        if (edge) removeEdge(edge.a, edge.b);
      }
    }
  };

  const onConnect = (connection: Connection) => {
    if (!addEdge(connection.source, connection.target)) return;
    const board = getCurrentWorkflow();
    for (const id of [connection.source, connection.target]) {
      const node = board.nodes.find((candidate) => candidate.id === id);
      if (!node) continue;
      void send(
        node,
        buildBoardInstructions(
          node.name,
          connectedNodeNames(board.nodes, board.edges, id),
          incomingNodeNames(board.nodes, board.edges, id),
        ),
      ).then((sent) => {
        appendLog(
          "info",
          sent
            ? `Sent updated board instructions to ${node.name}.`
            : `Updated instructions to ${node.name} failed.`,
        );
      });
    }
  };

  const deleteSelectedEdges = () => {
    for (const id of selectedEdgeIds) {
      const edge = edges.find((candidate) => `${candidate.a}:${candidate.b}` === id);
      if (edge) removeEdge(edge.a, edge.b);
    }
    setSelectedEdgeIds(new Set());
  };

  return (
    <SidebarInset className="h-dvh">
      <div className={`board-canvas relative min-h-0 flex-1${connecting ? " is-connecting" : ""}`}>
        {kanban ? (
          <BoardKanban workflow={workflow} />
        ) : (
          <OpenSettingsContext.Provider value={setSettingsNodeId}>
            <ReactFlow
              className="absolute! inset-0"
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeDragStart={() => recordHistoryStep()}
              onConnectStart={() => setConnecting(true)}
              onConnectEnd={() => setConnecting(false)}
              deleteKeyCode={["Backspace", "Delete"]}
              proOptions={{ hideAttribution: true }}
              fitView
              minZoom={0.2}
              maxZoom={1.6}
            >
              <Background color="var(--border)" gap={24} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </OpenSettingsContext.Provider>
        )}
        <BoardToolbar
          selectedRunId={selectedRun?.id ?? null}
          onSelectRun={setSelectedRunId}
          kanban={kanban}
          onToggleKanban={() => setKanban((value) => !value)}
          onAddAgent={() => {
            setAddingAgent(true);
            setAddingThread(false);
          }}
          onAddThread={() => setAddingThread((value) => !value)}
          selectedEdgeCount={selectedEdgeIds.size}
          onDeleteSelectedEdges={deleteSelectedEdges}
        />
        {selectedRun ? (
          <RunDetails run={selectedRun} onClose={() => setSelectedRunId(null)} />
        ) : null}
        {settingsNode ? (
          <NodeSettingsPanel
            key={settingsNode.id}
            node={settingsNode}
            onClose={() => setSettingsNodeId(null)}
          />
        ) : null}
        {addingThread ? <AddNodeForm onDone={() => setAddingThread(false)} /> : null}
      </div>
      {addingAgent ? <AddAgentDialog onClose={() => setAddingAgent(false)} /> : null}
    </SidebarInset>
  );
}
