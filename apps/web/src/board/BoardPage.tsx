import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProjectId, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  applyNodeChanges,
  Background,
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
import { ActivityIcon, MessageSquareIcon, SettingsIcon, XIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { EdgeRunView, NodeRunView } from "@t3tools/board-core/runView";

import { NodeSettingsPanel } from "./NodeSettingsPanel";
import { AddAgentDialog } from "./AddAgentDialog";
import {
  addEdge,
  createNode,
  nextNodePosition,
  useBoardConnection,
  useBoardState,
  getCurrentWorkflow,
  getWorkflow,
  isThreadOnBoard,
  recordHistoryStep,
  removeEdge,
  removeNode,
  retryBoardImport,
  updateNode,
  useCurrentWorkflow,
  useBoardPeers,
  type BoardNode,
} from "./boardStore";
import { AgentHandles } from "./foreman/AgentHandles";
import {
  AgentNodeView,
  type AgentNodeAction,
  type AgentNodeState,
  type AgentNodeTransition,
} from "./foreman/AgentNodeView";
import { SignalEdgeShape, type EdgePulse } from "./foreman/SignalEdgeShape";
import { AGENT_NODE_SIZE, useFloatingCurve } from "./foreman/signalEdge";
import { useHoverControls } from "./foreman/useHoverControls";
import "./foreman/foreman.css";
import { BoardTitle, BoardToolbar } from "./BoardToolbar";
import type { WorkflowNameHandle } from "./toolbar/WorkflowName";
import { useBoardMachines } from "./useBoardMachines";
import { BoardKanban } from "./toolbar/BoardKanban";
import { useNodeRunViews } from "./toolbar/useNodeStatuses";
import { RunActivityCard, type ActivityTarget } from "./RunActivity";
import { RunDetails } from "./toolbar/RunDetails";
import { useBoardPending } from "./boardApi";
import {
  Button,
  SidebarInset,
  WorkspacePageHeader,
  buildThreadRouteParams,
  isElectron,
  randomUUID,
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  useThreadShells,
} from "./upstream";

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

function AddNodeForm({ onDone }: { onDone: () => void }) {
  const connected = useBoardMachines();
  const threads = useThreadShells();
  const workflow = useCurrentWorkflow();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | "">("");
  const [threadId, setThreadId] = useState<ThreadId | "">("");
  const [name, setName] = useState("");
  const [manualProject, setManualProject] = useState("");
  const [manualThread, setManualThread] = useState("");
  const environmentThreads = threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      !isThreadOnBoard(thread.environmentId, thread.id),
  );
  const environmentLabel =
    connected.find((env) => env.environmentId === environmentId)?.label ?? "";

  const submit = async () => {
    const thread = environmentThreads.find((candidate) => candidate.id === threadId);
    const projectId =
      thread?.projectId ?? (manualProject.trim() ? ProjectId.make(manualProject.trim()) : null);
    const chosenThreadId =
      thread?.id ?? (manualThread.trim() ? ThreadId.make(manualThread.trim()) : null);
    if (environmentId === "" || !projectId || !chosenThreadId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createNode(workflow.id, {
        kind: "bind",
        id: randomUUID(),
        name: name.trim() || environmentLabel || "Agent",
        environmentId,
        projectId,
        threadId: chosenThreadId,
        ...nextNodePosition(workflow),
      });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
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
            setManualProject("");
            setManualThread("");
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
        {environmentThreads.length ? (
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
        ) : (
          <input
            className="h-8 rounded-md border bg-background px-2 text-sm"
            placeholder="Thread ID on this machine"
            value={manualThread}
            onChange={(event) => setManualThread(event.target.value)}
          />
        )}
      </label>
      {environmentThreads.length === 0 ? (
        <label>
          Project ID
          <input
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={manualProject}
            onChange={(event) => setManualProject(event.target.value)}
          />
        </label>
      ) : null}
      <label>
        Name
        <input
          className="h-8 rounded-md border bg-background px-2 text-sm font-normal text-foreground"
          placeholder={environmentLabel || "Agent name"}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={
            busy ||
            environmentId === "" ||
            (threadId === "" && (!manualProject.trim() || !manualThread.trim()))
          }
          onClick={() => void submit()}
        >
          Add node
        </Button>
      </div>
    </div>
  );
}

const OpenSettingsContext = createContext<(nodeId: string) => void>(() => {});
const OpenActivityContext = createContext<(nodeId: string) => void>(() => {});
const RunViewsContext = createContext<{
  nodes: ReadonlyMap<string, NodeRunView>;
  edges: ReadonlyMap<string, EdgeRunView>;
}>({ nodes: new Map(), edges: new Map() });

function transitionFor(
  before: AgentNodeState,
  after: AgentNodeState,
): AgentNodeTransition | undefined {
  if (after === before) return undefined;
  if (after === "running") return "ignite";
  if (after === "completed") return "complete";
  if (after === "failed") return "fail";
  if (after === "waiting") return "wait";
  return undefined;
}

/** Plays a cue once per state change; the first render shows the state without one. */
function useStateCue(state: AgentNodeState) {
  const [cue, setCue] = useState<{
    state: AgentNodeState;
    transition?: AgentNodeTransition;
    key: number;
  }>({ state, key: 0 });
  if (cue.state !== state) {
    const transition = transitionFor(cue.state, state);
    setCue({ state, key: cue.key + 1, ...(transition ? { transition } : {}) });
  }
  return cue;
}

const TRAVEL_GAP_MS = 180;

/** Crossings that appear after the edge mounted fly once; older ones are history and do not. */
function useEdgePulses(view: EdgeRunView | undefined): EdgePulse[] {
  const [initial] = useState(() => new Set(view?.crossings.map((crossing) => crossing.key)));
  // Get-or-set cache of start times, so a re-render never restarts a flight.
  const [starts] = useState(() => new Map<string, number>());
  const now = performance.now();
  const fresh = view?.crossings.filter((crossing) => !initial.has(crossing.key)) ?? [];
  return fresh.flatMap((crossing, index) => {
    let startsAt = starts.get(crossing.key);
    if (startsAt === undefined) {
      startsAt = now + index * TRAVEL_GAP_MS;
      starts.set(crossing.key, startsAt);
    }
    return startsAt > now - 4_000
      ? [
          {
            key: crossing.key,
            signal: crossing.signal,
            reversed: crossing.signal !== "task",
            startsAt,
          },
        ]
      : [];
  });
}

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
  const peers = useBoardPeers();
  const threads = useThreadShells();
  const openSettings = useContext(OpenSettingsContext);
  const openActivity = useContext(OpenActivityContext);
  const runView = useContext(RunViewsContext).nodes.get(node.id);

  const shell = threads.find(
    (thread) => thread.environmentId === node.environmentId && thread.id === node.threadId,
  );
  const machine =
    environments.find((environment) => environment.environmentId === node.environmentId)?.label ??
    peers.find((peer) => peer.environmentId === node.environmentId)?.name ??
    "Unknown";
  const fallback: NodeRunView = !connectedIds.includes(node.environmentId)
    ? { state: "unavailable", label: "Machine offline" }
    : shell && ACTIVE_STATUSES.has(shell.source.status)
      ? { state: "running", label: "Working" }
      : { state: "idle", label: "Idle" };
  const view = runView ?? fallback;
  const cue = useStateCue(view.state);
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
    {
      slot: "info",
      label: `${node.name} run activity`,
      icon: <ActivityIcon size={15} />,
      onClick: () => openActivity(node.id),
    },
  ];

  return (
    <AgentNodeView
      name={node.name}
      harness={harnessOf(instanceId)}
      harnessLabel={shell ? instanceId : "Thread not found"}
      model={shell?.modelSelection.model ?? null}
      machine={machine}
      statusLabel={view.label}
      state={view.state}
      {...(cue.transition ? { transition: cue.transition, transitionKey: cue.key } : {})}
      selected={selected}
      actions={actions}
    >
      <AgentHandles name={node.name} />
    </AgentNodeView>
  );
}

function SignalEdge({ id, source, target, selected }: EdgeProps) {
  const curve = useFloatingCurve(source, target);
  const view = useContext(RunViewsContext).edges.get(id);
  const pulses = useEdgePulses(view);
  const hover = useHoverControls();
  if (!curve) return null;
  const visible = hover.hovered || Boolean(selected);
  const { x, y } = curve.mid;
  return (
    <g onPointerEnter={hover.onPointerEnter} onPointerLeave={hover.onPointerLeave}>
      <SignalEdgeShape
        id={id}
        curve={curve}
        signal={view?.signal}
        pending={view?.pending ?? 0}
        pulses={pulses}
      />
      {visible ? (
        <rect className="board-edge-hover-bridge" x={x - 18} y={y - 36} width={36} height={48} />
      ) : null}
      <foreignObject
        data-visible={visible}
        className="board-edge-remove nodrag nopan"
        x={x - 18}
        y={y - 36}
        width={36}
        height={36}
      >
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Disconnect"
          title="Disconnect"
          onClick={(event) => {
            event.stopPropagation();
            removeEdge(source, target);
          }}
        >
          <XIcon size={14} />
        </Button>
      </foreignObject>
    </g>
  );
}

const NODE_TYPES = { agent: AgentCard };
const EDGE_TYPES = { signal: SignalEdge };

function toFlowNode(node: BoardNode, previous?: AgentFlowNode): AgentFlowNode {
  return previous
    ? {
        ...previous,
        position: previous.dragging ? previous.position : { x: node.x, y: node.y },
        data: { node },
      }
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
  useBoardConnection();
  const { snapshot, currentId, status, error } = useBoardState();
  const workflow =
    snapshot?.workflows.find((item) => item.id === currentId) ?? snapshot?.workflows[0];
  if (!workflow)
    return (
      <SidebarInset className="h-dvh">
        <div className="grid content-start gap-3 p-6">
          <p role="status">
            {status === "offline"
              ? `Board unavailable: ${error}`
              : status === "connected"
                ? "This board is empty."
                : "Connecting to board…"}
          </p>
          <div>
            <Button size="sm" variant="outline" render={<Link to="/" />}>
              Back
            </Button>
          </div>
        </div>
      </SidebarInset>
    );
  return <BoardCanvasPage key={workflow.id} />;
}

function BoardCanvasPage() {
  const workflow = useCurrentWorkflow();
  const { importError } = useBoardState();
  const pending = useBoardPending();
  const { nodes, edges } = workflow;
  const views = useNodeRunViews(workflow);
  const workflowName = useRef<WorkflowNameHandle>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [kanban, setKanban] = useState(false);
  const selectedRun = workflow.runs.find((run) => run.id === selectedRunId) ?? null;
  const [flowNodes, setFlowNodes] = useState<AgentFlowNode[]>(() =>
    nodes.map((n) => toFlowNode(n)),
  );
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const [activityNodeId, setActivityNodeId] = useState<string | null>(null);
  const selectedEdge =
    selectedEdgeIds.size === 1
      ? edges.find((edge) => selectedEdgeIds.has(`${edge.a}:${edge.b}`))
      : undefined;
  const activity: ActivityTarget | null =
    activityNodeId && nodes.some((node) => node.id === activityNodeId)
      ? { kind: "node", nodeId: activityNodeId }
      : selectedEdge
        ? { kind: "edge", from: selectedEdge.a, to: selectedEdge.b }
        : null;
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
      if (change.type === "position" && change.position && change.dragging === false) {
        void updateNode(change.id, { x: change.position.x, y: change.position.y }).then((saved) => {
          if (saved) return;
          const persisted = getWorkflow(workflow.id)?.nodes.find((node) => node.id === change.id);
          if (persisted)
            setFlowNodes((previous) =>
              previous.map((node) => (node.id === change.id ? toFlowNode(persisted, node) : node)),
            );
        });
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
    addEdge(connection.source, connection.target);
  };

  return (
    <SidebarInset className="h-dvh">
      <WorkspacePageHeader electron={isElectron} className="board-header border-b border-border">
        <BoardTitle nameRef={workflowName} />
      </WorkspacePageHeader>
      <div className={`board-canvas relative min-h-0 flex-1${connecting ? " is-connecting" : ""}`}>
        <div className="board-floating-controls">
          <BoardToolbar
            nameRef={workflowName}
            selectedRunId={selectedRun?.id ?? null}
            onSelectRun={setSelectedRunId}
            kanban={kanban}
            onToggleKanban={() => setKanban((value) => !value)}
            onAddAgent={() => {
              setAddingAgent(true);
              setAddingThread(false);
            }}
            onAddThread={() => setAddingThread((value) => !value)}
          />
        </div>
        {kanban ? (
          <BoardKanban workflow={workflow} />
        ) : (
          <OpenSettingsContext.Provider value={setSettingsNodeId}>
            <OpenActivityContext.Provider value={setActivityNodeId}>
              <RunViewsContext.Provider value={views}>
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
                </ReactFlow>
              </RunViewsContext.Provider>
            </OpenActivityContext.Provider>
          </OpenSettingsContext.Provider>
        )}
        {importError ? (
          <div className="absolute top-3 left-4 z-20 grid max-w-md gap-2 rounded-lg border bg-background p-3 text-sm shadow-lg">
            <p role="alert">Local workflows have not been imported. {importError}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void retryBoardImport()} disabled={pending}>
                Retry import
              </Button>
              <Button size="sm" variant="outline" render={<Link to="/settings/connections" />}>
                Connections
              </Button>
            </div>
          </div>
        ) : null}
        {selectedRun ? (
          <RunDetails run={selectedRun} onClose={() => setSelectedRunId(null)} />
        ) : null}
        {activity && !kanban ? (
          <RunActivityCard
            workflow={workflow}
            target={activity}
            onClose={() => {
              setActivityNodeId(null);
              setSelectedEdgeIds(new Set());
            }}
          />
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
