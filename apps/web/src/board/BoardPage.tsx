import { Link } from "@tanstack/react-router";
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

import { AgentSettingsDialog, NodeSettingsPanel } from "./NodeSettingsPanel";
import { AgentDialog } from "./AddAgentDialog";
import {
  addEdge,
  useBoardConnection,
  useBoardState,
  getCurrentWorkflow,
  getWorkflow,
  recordHistoryStep,
  removeEdge,
  openNodeChat,
  removeNode,
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
import { BoardTitle, BoardToolbar } from "./BoardToolbar";
import { BoardKanban } from "./toolbar/BoardKanban";
import { useNodeRunViews } from "./toolbar/useNodeStatuses";
import { useNodeConnections } from "./useNodeConnection";
import { RunActivityCard, type ActivityTarget } from "./RunActivity";
import { RunDetails } from "./toolbar/RunDetails";
import {
  Button,
  SidebarInset,
  WorkspacePageHeader,
  isElectron,
  useEnvironmentIdentities,
  useThreadShells,
} from "./upstream";

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const OpenSettingsContext = createContext<(nodeId: string) => void>(() => {});
const ConfigureContext = createContext<(nodeId: string) => void>(() => {});
const OpenActivityContext = createContext<(nodeId: string) => void>(() => {});
const RunViewsContext = createContext<{
  nodes: ReadonlyMap<string, NodeRunView>;
  edges: ReadonlyMap<string, EdgeRunView>;
  pulses: ReadonlyMap<string, EdgePulse[]>;
  /** Nodes with a pulse still flying toward them; they keep their previous status until it lands. */
  arriving: ReadonlySet<string>;
}>({ nodes: new Map(), edges: new Map(), pulses: new Map(), arriving: new Set() });

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
const TRAVEL_MS = 1400;

interface Flight {
  readonly pulse: EdgePulse;
  readonly edgeId: string;
  /** The node the pulse lands on: task pulses reach the target, return pulses the requester. */
  readonly to: string;
}

/**
 * Pulse start times live here, once per canvas. Crossings present on first render are history and
 * do not fly. A node's arrival is its incoming pulse landing, so the card can hold its previous
 * status until then.
 */
function useFlights(
  edgeViews: ReadonlyMap<string, EdgeRunView>,
  edges: ReadonlyArray<{ readonly a: string; readonly b: string }>,
) {
  const [state, setState] = useState(() => ({
    seen: new Set([...edgeViews.values()].flatMap((view) => view.crossings.map((c) => c.key))),
    flights: [] as Flight[],
    landed: new Set<string>(),
  }));
  const fresh: Flight[] = [];
  for (const edge of edges) {
    const edgeId = `${edge.a}:${edge.b}`;
    const crossings = (edgeViews.get(edgeId)?.crossings ?? []).filter(
      (c) => !state.seen.has(c.key),
    );
    crossings.forEach((crossing, index) =>
      fresh.push({
        edgeId,
        to: crossing.signal === "task" ? edge.b : edge.a,
        pulse: {
          key: crossing.key,
          signal: crossing.signal,
          reversed: crossing.signal !== "task",
          delay: index * TRAVEL_GAP_MS,
        },
      }),
    );
  }
  if (fresh.length > 0)
    setState({
      ...state,
      seen: new Set([...state.seen, ...fresh.map((flight) => flight.pulse.key)]),
      flights: [...state.flights, ...fresh].slice(-40),
    });

  const deadlines = useRef(new Map<string, number>());
  // oxlint-disable-next-line t3code/react-effect-budget -- arrival is a timer that outlives the render: pulse start and travel time cannot be read in render
  useEffect(() => {
    const timers: number[] = [];
    for (const { pulse } of state.flights) {
      if (state.landed.has(pulse.key)) continue;
      const deadline =
        deadlines.current.get(pulse.key) ?? performance.now() + pulse.delay + TRAVEL_MS;
      deadlines.current.set(pulse.key, deadline);
      timers.push(
        window.setTimeout(
          () =>
            setState((current) => ({ ...current, landed: new Set(current.landed).add(pulse.key) })),
          Math.max(0, deadline - performance.now()),
        ),
      );
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [state.flights, state.landed]);

  const pulses = new Map<string, EdgePulse[]>();
  const arriving = new Set<string>();
  for (const flight of [...state.flights, ...fresh]) {
    pulses.set(flight.edgeId, [...(pulses.get(flight.edgeId) ?? []), flight.pulse].slice(-20));
    if (!state.landed.has(flight.pulse.key)) arriving.add(flight.to);
  }
  return { pulses, arriving };
}

/** Shows the node's previous status while a pulse is still on its way, then switches. */
function useHeldView(view: NodeRunView, held: boolean) {
  const [shown, setShown] = useState(view);
  if (!held && (shown.state !== view.state || shown.label !== view.label)) setShown(view);
  return held ? shown : view;
}

type AgentFlowNode = Node<{ readonly node: BoardNode }, "agent">;

function harnessOf(instanceId: string): "codex" | "claude" | "neutral" {
  const id = instanceId.toLowerCase();
  return id.includes("codex") ? "codex" : id.includes("claude") ? "claude" : "neutral";
}

function AgentCard({ data, selected }: NodeProps<AgentFlowNode>) {
  const { node } = data;
  const connectionOf = useNodeConnections();
  const environments = useEnvironmentIdentities();
  const peers = useBoardPeers();
  const threads = useThreadShells();
  const openSettings = useContext(OpenSettingsContext);
  const configure = useContext(ConfigureContext);
  const openActivity = useContext(OpenActivityContext);
  const { nodes: runViews, arriving } = useContext(RunViewsContext);
  const runView = runViews.get(node.id);

  const shell = threads.find(
    (thread) => thread.environmentId === node.environmentId && thread.id === node.threadId,
  );
  const machine =
    environments.find((environment) => environment.environmentId === node.environmentId)?.label ??
    peers.find((peer) => peer.environmentId === node.environmentId)?.name ??
    "Unknown";
  const connection = connectionOf(node.environmentId);
  const fallback: NodeRunView =
    connection !== "connected"
      ? {
          state: "unavailable",
          label: connection === "offline" ? "Machine offline" : "Reconnecting…",
        }
      : shell && ACTIVE_STATUSES.has(shell.source.status)
        ? { state: "running", label: "Working" }
        : { state: "idle", label: "Idle" };
  const view = useHeldView(runView ?? fallback, arriving.has(node.id));
  const cue = useStateCue(view.state);
  const instanceId = String(node.modelSelection.instanceId);

  const actions: AgentNodeAction[] = [
    {
      slot: "chat",
      label: `Open ${node.name} thread`,
      icon: <MessageSquareIcon size={15} />,
      onClick: () => {
        openSettings(node.id);
        if (node.threadId === "") void openNodeChat(node.id);
      },
    },
    {
      slot: "settings",
      label: `${node.name} settings`,
      icon: <SettingsIcon size={15} />,
      onClick: () => configure(node.id),
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
      harnessLabel={instanceId}
      model={node.modelSelection.model}
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
  const { edges, pulses: allPulses } = useContext(RunViewsContext);
  const view = edges.get(id);
  const pulses = allPulses.get(id) ?? [];
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
  const { nodes, edges } = workflow;
  const views = useNodeRunViews(workflow);
  const flights = useFlights(views.edges, edges);
  const [editingName, setEditingName] = useState(false);
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
  const [connecting, setConnecting] = useState(false);
  const [settingsNodeId, setSettingsNodeId] = useState<string | null>(null);
  const settingsNode = nodes.find((n) => n.id === settingsNodeId) ?? null;
  const [configureNodeId, setConfigureNodeId] = useState<string | null>(null);
  const configureNode = nodes.find((n) => n.id === configureNodeId) ?? null;

  const displayedNodes = nodes.map((node) =>
    toFlowNode(
      node,
      flowNodes.find((candidate) => candidate.id === node.id),
    ),
  );

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
    setFlowNodes((previous) =>
      applyNodeChanges(
        changes,
        nodes.map((node) =>
          toFlowNode(
            node,
            previous.find((item) => item.id === node.id),
          ),
        ),
      ),
    );
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
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <BoardTitle editing={editingName} onEditingChange={setEditingName} />
      </WorkspacePageHeader>
      <div className={`board-canvas relative min-h-0 flex-1${connecting ? " is-connecting" : ""}`}>
        <div className="board-floating-controls">
          <BoardToolbar
            onRename={() => setEditingName(true)}
            selectedRunId={selectedRun?.id ?? null}
            onSelectRun={setSelectedRunId}
            kanban={kanban}
            onToggleKanban={() => setKanban((value) => !value)}
            onAddAgent={() => setAddingAgent(true)}
          />
        </div>
        <OpenSettingsContext.Provider value={setSettingsNodeId}>
          <ConfigureContext.Provider value={setConfigureNodeId}>
            <OpenActivityContext.Provider value={setActivityNodeId}>
              <RunViewsContext.Provider value={{ ...views, ...flights }}>
                <ReactFlow
                  className="absolute! inset-0"
                  nodes={displayedNodes}
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
          </ConfigureContext.Provider>
        </OpenSettingsContext.Provider>
        {kanban ? <BoardKanban workflow={workflow} onClose={() => setKanban(false)} /> : null}
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
        {configureNode ? (
          <AgentSettingsDialog
            key={configureNode.id}
            node={configureNode}
            onClose={() => setConfigureNodeId(null)}
          />
        ) : null}
        {settingsNode ? (
          <NodeSettingsPanel
            key={settingsNode.id}
            node={settingsNode}
            onClose={() => setSettingsNodeId(null)}
          />
        ) : null}
      </div>
      {addingAgent ? <AgentDialog onClose={() => setAddingAgent(false)} /> : null}
    </SidebarInset>
  );
}
