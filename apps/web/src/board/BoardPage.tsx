import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  applyNodeChanges,
  Background,
  Controls,
  ConnectionMode,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useState } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { useThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { AddAgentDialog } from "./AddAgentDialog";
import { useSendToBoardNode } from "./BoardEngine";
import {
  addEdge,
  addNode,
  appendLog,
  getBoardState,
  removeEdge,
  removeNode,
  updateNode,
  useBoardState,
  type BoardNode,
} from "./boardStore";
import { buildBoardInstructions, connectedNodeNames } from "./wakeProtocol";

const CARD_WIDTH = 260;
const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const FIELD_CLASS = "h-8 rounded-md border bg-background px-2 text-sm";

function AddNodeForm() {
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
      thread.deletedAt === null,
  );
  const environmentLabel =
    connected.find((env) => env.environmentId === environmentId)?.label ?? "";

  const submit = () => {
    if (environmentId === "" || threadId === "") return;
    addNode({ name: name.trim() || environmentLabel || "Agent", environmentId, threadId });
    setThreadId("");
    setName("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={FIELD_CLASS}
        value={environmentId}
        onChange={(event) => {
          setEnvironmentId(event.target.value as EnvironmentId | "");
          setThreadId("");
        }}
      >
        <option value="">Environment...</option>
        {connected.map((environment) => (
          <option key={environment.environmentId} value={environment.environmentId}>
            {environment.label}
          </option>
        ))}
      </select>
      <select
        className={`${FIELD_CLASS} max-w-64`}
        value={threadId}
        onChange={(event) => setThreadId(event.target.value as ThreadId | "")}
      >
        <option value="">Thread...</option>
        {environmentThreads.map((thread) => (
          <option key={thread.id} value={thread.id}>
            {thread.title}
          </option>
        ))}
      </select>
      <input
        className={`${FIELD_CLASS} w-36`}
        placeholder={environmentLabel || "Name"}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Button size="sm" disabled={threadId === ""} onClick={submit}>
        Add node
      </Button>
    </div>
  );
}

type AgentFlowNode = Node<{ readonly node: BoardNode }, "agent">;

function AgentCard({ data }: NodeProps<AgentFlowNode>) {
  const { node } = data;
  const navigate = useNavigate();
  const { nodes, edges } = useBoardState();
  const connectedIds = useConnectedEnvironmentIds();
  const environments = useEnvironmentIdentities();
  const threads = useThreadShells();
  const send = useSendToBoardNode();

  const shell = threads.find(
    (thread) => thread.environmentId === node.environmentId && thread.id === node.threadId,
  );
  const environmentLabel =
    environments.find((environment) => environment.environmentId === node.environmentId)?.label ??
    "Unknown";
  const status = !connectedIds.includes(node.environmentId)
    ? "disconnected"
    : shell && ACTIVE_STATUSES.has(shell.source.status)
      ? "working"
      : "idle";
  const model = shell ? `${shell.modelSelection.instanceId} / ${shell.modelSelection.model}` : null;
  const peerNames = connectedNodeNames(nodes, edges, node.id);

  const sendInstructions = async () => {
    const sent = await send(node, buildBoardInstructions(node.name, peerNames));
    appendLog(
      "info",
      sent ? `Sent board instructions to ${node.name}.` : `Instructions to ${node.name} failed.`,
    );
  };

  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border bg-card p-2 text-sm text-card-foreground shadow-sm"
      style={{ width: CARD_WIDTH }}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{node.name}</span>
        <span
          className={`shrink-0 rounded px-1.5 text-xs ${
            status === "working"
              ? "bg-info/16 text-info-foreground"
              : status === "disconnected"
                ? "bg-destructive/16 text-destructive-foreground"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {status}
        </span>
      </div>
      <div className="truncate text-xs text-muted-foreground">{environmentLabel}</div>
      {model ? <div className="truncate text-xs text-muted-foreground">{model}</div> : null}
      <div className="truncate text-xs">{shell?.title ?? "Thread not found"}</div>
      {peerNames.length > 0 ? (
        <div className="truncate text-xs text-muted-foreground">
          Connected: {peerNames.join(", ")}
        </div>
      ) : null}
      <div className="nodrag flex flex-wrap gap-1">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(node.environmentId, node.threadId)),
            })
          }
        >
          Open thread
        </Button>
        <Button size="xs" variant="outline" onClick={sendInstructions}>
          Send board instructions
        </Button>
        <Button size="xs" variant="ghost-destructive" onClick={() => removeNode(node.id)}>
          Remove
        </Button>
      </div>
    </div>
  );
}

const NODE_TYPES = { agent: AgentCard };

function toFlowNode(node: BoardNode, previous?: AgentFlowNode): AgentFlowNode {
  return previous
    ? { ...previous, data: { node } }
    : { id: node.id, type: "agent", position: { x: node.x, y: node.y }, data: { node } };
}

export function BoardPage() {
  const { nodes, edges, pending } = useBoardState();
  const send = useSendToBoardNode();
  const [flowNodes, setFlowNodes] = useState<AgentFlowNode[]>(() =>
    nodes.map((n) => toFlowNode(n)),
  );
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const [addingAgent, setAddingAgent] = useState(false);

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
    return { id, source: edge.a, target: edge.b, selected: selectedEdgeIds.has(id) };
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
        const edge = getBoardState().edges.find(
          (candidate) => `${candidate.a}:${candidate.b}` === change.id,
        );
        if (edge) removeEdge(edge.a, edge.b);
      }
    }
  };

  const onConnect = (connection: Connection) => {
    if (!addEdge(connection.source, connection.target)) return;
    const board = getBoardState();
    for (const id of [connection.source, connection.target]) {
      const node = board.nodes.find((candidate) => candidate.id === id);
      if (!node) continue;
      void send(
        node,
        buildBoardInstructions(node.name, connectedNodeNames(board.nodes, board.edges, id)),
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
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-medium">Board</h1>
        <Button size="sm" onClick={() => setAddingAgent(true)}>
          Add agent
        </Button>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Add existing thread</summary>
          <div className="pt-2">
            <AddNodeForm />
          </div>
        </details>
        {selectedEdgeIds.size > 0 ? (
          <Button size="sm" variant="outline" onClick={deleteSelectedEdges}>
            Delete selected edge
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">{pending.length} pending</span>
      </header>
      <div className="relative min-h-0 flex-1">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          connectionMode={ConnectionMode.Loose}
          colorMode="system"
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          minZoom={0.2}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      {addingAgent ? <AddAgentDialog onClose={() => setAddingAgent(false)} /> : null}
    </SidebarInset>
  );
}
