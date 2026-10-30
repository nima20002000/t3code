import { Link } from "@tanstack/react-router";
import {
  applyNodeChanges,
  Background,
  ReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  GlobeIcon,
  MessageSquareIcon,
  SettingsIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { EdgeRunView, NodeRunView } from "@t3tools/board-core/runView";

import { AgentSettingsWindow, ChatWindow } from "./NodeSettingsPanel";
import { BrowserWindow, TerminalWindow, useAgentTools } from "./ChatTools";
import {
  BoardWindowsProvider,
  syncNativeViews,
  loadWindows,
  followComposerMenus,
  newWindowNode,
  saveWindows,
  useBoardWindows,
  windowId,
  type BoardWindowKind,
  type BoardWindowProps,
  type WindowFlowNode,
  type WindowOptions,
} from "./BoardWindows";
import { copyNodes, deleteNodes, duplicateNodes, hasCopiedNodes, pasteNodes } from "./nodeActions";
import { AgentDialog } from "./AddAgentDialog";
import { NodeScheduleButton } from "./NodeSchedule";
import {
  addEdge,
  redo,
  undo,
  useBoardConnection,
  useBoardState,
  getCurrentWorkflow,
  recordHistoryStep,
  removeEdge,
  openNodeChat,
  removeNode,
  updateNode,
  useCurrentWorkflow,
  type Workflow,
  useBoardPeers,
  type BoardNode,
  type KanbanPlacement,
  activeRunOf,
  placeKanban,
} from "./boardStore";
import { useConnectBoardMachines } from "./useConnectBoardMachines";
import { AgentHandles } from "./foreman/AgentHandles";
import {
  AgentNodeView,
  type AgentNodeState,
  type AgentNodeTransition,
} from "./foreman/AgentNodeView";
import { SignalEdgeShape, type EdgePulse } from "./foreman/SignalEdgeShape";
import { agentNodeSize, useFloatingCurve } from "./foreman/signalEdge";
import { useHoverControls } from "./foreman/useHoverControls";
import { claimBoardStartup } from "./BoardNavigation";
import { BoardTitle, BoardToolbar } from "./BoardToolbar";
import {
  BoardKanban,
  DEFAULT_KANBAN_SIZE,
  KANBAN_NODE_ID,
  kanbanNode,
  type KanbanFlowNode,
} from "./BoardKanban";
import { useNodeRunViews } from "./toolbar/useNodeStatuses";
import { useNodeConnections } from "./useNodeConnection";
import { RunActivityCard, type ActivityTarget } from "./RunActivity";
import { RunDetails } from "./toolbar/RunDetails";
import {
  Button,
  SidebarInset,
  WorkspacePageHeader,
  isElectron,
  readLocalApi,
  useEnvironmentIdentities,
  useStableCallback,
  useThreadShells,
} from "./upstream";

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const RunViewsContext = createContext<{
  nodes: ReadonlyMap<string, NodeRunView>;
  edges: ReadonlyMap<string, EdgeRunView>;
  pulses: ReadonlyMap<string, EdgePulse[]>;
  /** Nodes with a pulse still flying toward them; they keep their previous status until it lands. */
  /** Nodes whose shown state waits for a pulse in flight: its target, and the sender of a return. */
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
  readonly from: string;
}

/**
 * Pulse start times live here, once per canvas. Crossings present on first render are history and
 * do not fly. A node's arrival is its incoming pulse landing, so the card can hold its previous
 * status until then.
 */
/**
 * Every agent and edge reads the run views, which are rebuilt on every board render, including each
 * frame of a drag; the value is kept while its content is the same.
 */
function RunViewsProvider(props: {
  readonly views: ReturnType<typeof useNodeRunViews>;
  readonly flights: ReturnType<typeof useFlights>;
  readonly children: ReactNode;
}) {
  const next = { ...props.views, ...props.flights };
  const key = JSON.stringify([
    [...next.nodes],
    [...next.edges],
    [...next.pulses],
    [...next.arriving],
  ]);
  const [held, setHeld] = useState({ key, value: next });
  if (held.key !== key) setHeld({ key, value: next });
  return (
    <RunViewsContext.Provider value={held.key === key ? held.value : next}>
      {props.children}
    </RunViewsContext.Provider>
  );
}

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
        from: crossing.signal === "task" ? edge.a : edge.b,
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- arrival is a timer that outlives the render: pulse start and travel time cannot be read in render
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
    if (state.landed.has(flight.pulse.key)) continue;
    arriving.add(flight.to);
    // A worker's result is still on its way: it keeps showing its work until the return lands.
    if (flight.pulse.signal !== "task") arriving.add(flight.from);
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
type BoardFlowNode = AgentFlowNode | WindowFlowNode | KanbanFlowNode;

function harnessOf(instanceId: string): "codex" | "claude" | "neutral" {
  const id = instanceId.toLowerCase();
  return id.includes("codex") ? "codex" : id.includes("claude") ? "claude" : "neutral";
}

const MIN_NODE_SIZE = 140;
const MAX_NODE_SIZE = 520;

function AgentCard({ data, selected, width }: NodeProps<AgentFlowNode>) {
  const { node } = data;
  const connectionOf = useNodeConnections();
  const environments = useEnvironmentIdentities();
  const peers = useBoardPeers();
  const threads = useThreadShells();
  const windows = useBoardWindows();
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

  const chat = {
    label: `Open ${node.name} thread`,
    icon: <MessageSquareIcon size={14} />,
    onClick: () => {
      windows.open("chat", node.id);
      if (node.threadId === "") void openNodeChat(node.id);
    },
  };

  const settings = {
    label: `${node.name} settings`,
    icon: <SettingsIcon size={14} />,
    onClick: () => windows.open("settings", node.id),
  };
  const tools = useAgentTools(node);
  const actions = tools
    ? [
        chat,
        {
          label: `${node.name} terminal`,
          icon: <SquareTerminalIcon size={14} />,
          onClick: tools.openTerminal,
        },
        {
          label: `${node.name} browser`,
          icon: <GlobeIcon size={14} />,
          onClick: tools.openBrowser,
        },
        settings,
      ]
    : [chat, settings];

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
      size={width ?? agentNodeSize(node)}
      actions={actions}
      accessory={<NodeScheduleButton node={node} />}
      role={node.profile === "orchestrator" ? "Orchestrator" : "Worker"}
    >
      <ResizeRing
        nodeId={node.id}
        onResizeEnd={(x, y, size) => updateNode(node.id, { x, y, size })}
      />
      <AgentHandles name={node.name} />
    </AgentNodeView>
  );
}

const RING_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

/** The pointer's direction from the center, as the resize cursor pointing that way. */
function ringCursor(dx: number, dy: number) {
  const octant = Math.round((Math.atan2(dy, dx) / Math.PI) * 4);
  return RING_CURSORS[((octant % 4) + 4) % 4] ?? "ew-resize";
}

/** Resizes the circle from its rim, keeping its center in place. */
function ResizeRing({
  nodeId,
  onResizeEnd,
}: {
  nodeId: string;
  onResizeEnd: (x: number, y: number, size: number) => Promise<unknown>;
}) {
  const store = useStoreApi<AgentFlowNode>();
  const centerOf = (ring: Element) => {
    const box = ring.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const center = centerOf(event.currentTarget);
    event.currentTarget.style.cursor = ringCursor(
      event.clientX - center.x,
      event.clientY - center.y,
    );
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const node = store.getState().nodeLookup.get(nodeId);
    if (event.button !== 0 || !node) return;
    event.preventDefault();
    event.stopPropagation();
    const ring = event.currentTarget;
    ring.setPointerCapture(event.pointerId);
    recordHistoryStep();
    const screenCenter = centerOf(ring);
    const startSize = node.width ?? node.measured.width ?? 0;
    const center = { x: node.position.x + startSize / 2, y: node.position.y + startSize / 2 };
    let last = { x: node.position.x, y: node.position.y, size: startSize };
    const move = (moveEvent: globalThis.PointerEvent) => {
      const { transform, triggerNodeChanges } = store.getState();
      const radius = Math.hypot(
        moveEvent.clientX - screenCenter.x,
        moveEvent.clientY - screenCenter.y,
      );
      const size = Math.round(
        Math.min(MAX_NODE_SIZE, Math.max(MIN_NODE_SIZE, (2 * radius) / transform[2])),
      );
      last = { x: center.x - size / 2, y: center.y - size / 2, size };
      triggerNodeChanges([
        { id: nodeId, type: "position", position: { x: last.x, y: last.y } },
        {
          id: nodeId,
          type: "dimensions",
          resizing: true,
          setAttributes: true,
          dimensions: { width: size, height: size },
        },
      ]);
    };
    // The node stays in its resizing state until the save lands, so it does not flash back.
    const end = () => {
      ring.removeEventListener("pointermove", move);
      ring.removeEventListener("pointerup", end);
      ring.removeEventListener("pointercancel", end);
      void onResizeEnd(last.x, last.y, last.size).finally(() =>
        store.getState().triggerNodeChanges([
          {
            id: nodeId,
            type: "dimensions",
            resizing: false,
            dimensions: { width: last.size, height: last.size },
          },
        ]),
      );
    };
    ring.addEventListener("pointermove", move);
    ring.addEventListener("pointerup", end);
    ring.addEventListener("pointercancel", end);
  };
  return (
    <svg
      className="n-agent-resize nodrag nopan"
      viewBox="0 0 100 100"
      aria-hidden="true"
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
    >
      <circle className="n-agent-resize-hit" cx="50" cy="50" r="50" />
      <circle className="n-agent-resize-line" cx="50" cy="50" r="50" />
    </svg>
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

function BoardWindowNode(props: BoardWindowProps) {
  switch (props.data.kind) {
    case "chat":
      return <ChatWindow {...props} />;
    case "browser":
      return <BrowserWindow {...props} />;
    case "terminal":
      return <TerminalWindow {...props} />;
    case "settings":
      return <AgentSettingsWindow {...props} />;
  }
}

const NODE_TYPES = { agent: AgentCard, window: BoardWindowNode, kanban: BoardKanban };

const EDGE_TYPES = { signal: SignalEdge };

function toFlowNode(node: BoardNode, previous?: AgentFlowNode): AgentFlowNode {
  const size = agentNodeSize(node);
  // An unchanged node keeps its object, so React Flow doesn't re-render it while others move.
  if (
    previous?.data.node === node &&
    (previous.resizing || (previous.width === size && previous.height === size)) &&
    (previous.dragging ||
      previous.resizing ||
      (previous.position.x === node.x && previous.position.y === node.y))
  ) {
    return previous;
  }
  return previous
    ? {
        ...previous,
        position:
          previous.dragging || previous.resizing ? previous.position : { x: node.x, y: node.y },
        ...(previous.resizing ? {} : { width: size, height: size }),
        data: { node },
      }
    : {
        id: node.id,
        type: "agent",
        position: { x: node.x, y: node.y },
        width: size,
        height: size,
        data: { node },
      };
}

/** Keyed by workflow id so switching workflows resets the canvas, its selection and the fit. */
export function BoardPage() {
  // Reaching the board any way counts as the startup visit, so Back to "/" stays on t3.
  claimBoardStartup();
  useBoardConnection();
  useConnectBoardMachines();
  const { snapshot, currentId, status, error } = useBoardState();
  const workflow =
    snapshot?.workflows.find((item) => item.id === currentId) ?? snapshot?.workflows[0];
  if (!workflow)
    return (
      <SidebarInset className="h-dvh">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="grid content-start gap-3 p-6">
          <p role="status">
            {status === "offline"
              ? `Board unavailable: ${error}`
              : status === "connected"
                ? snapshot?.workspaces.length
                  ? "No workflow yet. Create one in a workspace from the left menu."
                  : "No workspace yet. Create one from the left menu, then add a workflow to it."
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

const newestRunId = (workflow: Workflow) =>
  workflow.runs.reduce<{ id: string; startedAt: string } | null>(
    (newest, run) => (newest === null || run.startedAt > newest.startedAt ? run : newest),
    null,
  )?.id ?? null;
const FRAME_PADDING = { top: "72px", bottom: "48px", x: "48px" } as const;

function BoardCanvasPage() {
  const workflow = useCurrentWorkflow();
  const { nodes, edges } = workflow;
  const views = useNodeRunViews(workflow);
  const flights = useFlights(views.edges, edges);
  const [editingName, setEditingName] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const flow = useRef<ReactFlowInstance<BoardFlowNode, Edge> | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [fullScreenLayer, setFullScreenLayer] = useState<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep native browser views and the composer menu on their board windows.
  useEffect(() => {
    if (!canvas.current || !fullScreenLayer) return;
    const stopViews = syncNativeViews(canvas.current, fullScreenLayer);
    const stopMenus = followComposerMenus(canvas.current);
    return () => {
      stopViews();
      stopMenus();
    };
  }, [fullScreenLayer]);
  const runningId = activeRunOf(workflow)?.id ?? null;
  // When a run starts, the agents (and the kanban, when it is on the board) are framed.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Frame React Flow's viewport when a run starts.
  useEffect(() => {
    if (!runningId) return;
    const frame = requestAnimationFrame(() => {
      void flow.current?.fitView({ padding: FRAME_PADDING, maxZoom: 1, duration: 300 });
    });
    return () => cancelAnimationFrame(frame);
  }, [runningId]);
  const selectedRun = workflow.runs.find((run) => run.id === selectedRunId) ?? null;
  const [flowNodes, setFlowNodes] = useState<AgentFlowNode[]>(() =>
    nodes.map((n) => toFlowNode(n)),
  );
  // Where agents were dropped, held until the store reports that move, so they don't jump back.
  // Once saved, any later change to the node (another viewer moving it, say) also releases it.
  type Drop = { readonly x: number; readonly y: number; readonly savedOver?: BoardNode };
  const [dropped, setDropped] = useState<ReadonlyMap<string, Drop>>(new Map());
  const settled = [...dropped].filter(([id, drop]) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return (
      !node ||
      (node.x === drop.x && node.y === drop.y) ||
      (drop.savedOver !== undefined && node !== drop.savedOver)
    );
  });
  if (settled.length > 0) {
    setDropped((previous) => {
      const next = new Map(previous);
      for (const [id, drop] of settled) if (next.get(id) === drop) next.delete(id);
      return next;
    });
  }
  const atDrop = (node: BoardNode) => {
    const drop = dropped.get(node.id);
    return drop ? { ...node, x: drop.x, y: drop.y } : node;
  };
  // The kanban's spot while it is dragged or resized, then while it saves: any placement the store
  // reports after the save was sent (this one, another viewer's, a fresh snapshot) takes over. Taken
  // off the board mid-gesture, it stays off: the gesture's end is not saved.
  type KanbanDraft = {
    readonly placement: KanbanPlacement;
    readonly sentOver?: KanbanPlacement | undefined;
  };
  const [kanbanDraft, setKanbanDraft] = useState<KanbanDraft | null>(null);
  const [kanbanSelected, setKanbanSelected] = useState(false);
  if (
    kanbanDraft &&
    ("sentOver" in kanbanDraft
      ? workflow.kanban !== kanbanDraft.sentOver
      : workflow.kanban === undefined)
  ) {
    setKanbanDraft(null);
  }
  const kanbanPlacement = kanbanDraft?.placement ?? workflow.kanban;
  // An agent could carry the kanban's id; the kanban then stays off the canvas rather than hide it.
  const kanbanIdFree = !nodes.some((node) => node.id === KANBAN_NODE_ID);
  const kanbanFlowNode =
    kanbanPlacement && kanbanIdFree
      ? kanbanNode(kanbanPlacement, selectedRun?.id ?? newestRunId(workflow), kanbanSelected)
      : null;
  const saveKanban = (placement: KanbanPlacement) => {
    const draft: KanbanDraft = { placement, sentOver: getCurrentWorkflow().kanban };
    setKanbanDraft(draft);
    void placeKanban(placement).then((saved) => {
      if (!saved) setKanbanDraft((current) => (current === draft ? null : current));
    });
  };
  const frameKanban = (all: boolean) =>
    requestAnimationFrame(() => {
      void flow.current?.fitView({
        padding: FRAME_PADDING,
        maxZoom: 1,
        duration: 300,
        ...(all ? {} : { nodes: [{ id: KANBAN_NODE_ID }] }),
      });
    });
  // On the board: frame it. Off it: put it under the agents (or mid-view on an empty board).
  const onKanban = () => {
    if (kanbanFlowNode) {
      frameKanban(false);
      return;
    }
    const { width, height } = DEFAULT_KANBAN_SIZE;
    let placement: KanbanPlacement;
    if (nodes.length > 0) {
      const left = Math.min(...nodes.map((node) => node.x));
      const right = Math.max(...nodes.map((node) => node.x + agentNodeSize(node)));
      const bottom = Math.max(...nodes.map((node) => node.y + agentNodeSize(node)));
      placement = { x: (left + right) / 2 - width / 2, y: bottom + 64, width, height };
    } else {
      const box = canvas.current?.getBoundingClientRect();
      const center = flow.current?.screenToFlowPosition({
        x: (box?.left ?? 0) + (box?.width ?? 0) / 2,
        y: (box?.top ?? 0) + (box?.height ?? 0) / 2,
      }) ?? { x: 0, y: 0 };
      placement = { x: center.x - width / 2, y: center.y - height / 2, width, height };
    }
    saveKanban({
      ...placement,
      x: Math.round(placement.x),
      y: Math.round(placement.y),
    });
    frameKanban(true);
  };
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const selectedEdge =
    selectedEdgeIds.size === 1
      ? edges.find((edge) => selectedEdgeIds.has(`${edge.a}:${edge.b}`))
      : undefined;
  const activity: ActivityTarget | null = selectedEdge
    ? { kind: "edge", from: selectedEdge.a, to: selectedEdge.b }
    : null;
  const [addingAgent, setAddingAgent] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [fullScreen, setFullScreen] = useState<string | null>(null);
  const [windowNodes, setWindowNodesState] = useState(() => loadWindows(workflow.id));
  const workflowId = workflow.id;
  const setWindowNodes = (update: (previous: WindowFlowNode[]) => WindowFlowNode[], save = true) =>
    setWindowNodesState((previous) => {
      const next = update(previous);
      if (save) saveWindows(workflowId, next);
      return next;
    });
  const openWindows = windowNodes.filter((window) =>
    nodes.some((node) => node.id === window.data.nodeId),
  );
  // Windows move every frame of a drag, and every window and agent reads this context, so it
  // changes only when a window opens or closes.
  const openIds = openWindows.map((window) => window.id).join("\n");
  // A full-screen window that's gone (closed, or its agent removed) doesn't come back full screen.
  if (fullScreen !== null && !openIds.split("\n").includes(fullScreen)) setFullScreen(null);
  const open = useStableCallback(
    (kind: BoardWindowKind, nodeId: string, options: WindowOptions = {}) => {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      const id = windowId(kind, nodeId);
      setWindowNodes((previous) =>
        previous.some((window) => window.id === id)
          ? previous.map((window) =>
              window.id === id ? { ...window, data: { ...window.data, ...options } } : window,
            )
          : [...previous, newWindowNode(kind, node, previous, options)],
      );
    },
  );
  const close = useStableCallback((id: string) => {
    setWindowNodes((previous) => previous.filter((window) => window.id !== id));
    setFullScreen((current) => (current === id ? null : current));
  });

  const displayedNodes = nodes.map((node) =>
    toFlowNode(
      atDrop(node),
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

  // Windows live only on this canvas; agent and kanban changes go to the store.
  const onNodesChange = (everyChange: NodeChange<BoardFlowNode>[]) => {
    const idOf = (change: NodeChange<BoardFlowNode>) =>
      "id" in change ? change.id : change.item.id;
    const isKanban = (change: NodeChange<BoardFlowNode>) =>
      kanbanIdFree && idOf(change) === KANBAN_NODE_ID;
    const kanbanChanges = everyChange.filter(isKanban) as NodeChange<KanbanFlowNode>[];
    if (kanbanFlowNode && kanbanChanges.length > 0) onKanbanChanges(kanbanChanges, kanbanFlowNode);
    const allChanges = everyChange.filter((change) => !isKanban(change));
    const isWindow = (change: NodeChange<BoardFlowNode>) =>
      windowNodes.some((window) => window.id === ("id" in change ? change.id : change.item.id));
    const windowChanges = allChanges.filter(isWindow) as NodeChange<WindowFlowNode>[];
    if (windowChanges.length > 0) {
      // Saved once a drag or resize settles, not on every frame of it.
      const settling = windowChanges.some(
        (change) =>
          (change.type === "position" && change.dragging) ||
          (change.type === "dimensions" && change.resizing),
      );
      setWindowNodes((previous) => applyNodeChanges(windowChanges, previous), !settling);
    }
    const changes = allChanges.filter((change) => !isWindow(change)) as NodeChange<AgentFlowNode>[];
    if (changes.length === 0) return;
    setFlowNodes((previous) =>
      applyNodeChanges(
        changes,
        nodes.map((node) =>
          toFlowNode(
            atDrop(node),
            previous.find((item) => item.id === node.id),
          ),
        ),
      ),
    );
    for (const change of changes) {
      if (change.type === "position" && change.position && change.dragging === false) {
        const drop: Drop = { x: change.position.x, y: change.position.y };
        setDropped((previous) => new Map(previous).set(change.id, drop));
        void updateNode(change.id, { x: drop.x, y: drop.y }).then((saved) => {
          const savedOver = getCurrentWorkflow().nodes.find((node) => node.id === change.id);
          setDropped((previous) => {
            if (previous.get(change.id) !== drop) return previous;
            const next = new Map(previous);
            if (saved && savedOver) next.set(change.id, { ...drop, savedOver });
            else next.delete(change.id);
            return next;
          });
        });
      } else if (change.type === "remove") {
        removeNode(change.id);
      }
    }
  };

  const onKanbanChanges = (changes: NodeChange<KanbanFlowNode>[], current: KanbanFlowNode) => {
    for (const change of changes) {
      if (change.type === "select") setKanbanSelected(change.selected);
      if (change.type === "remove") void placeKanban(null);
    }
    // Measuring the node is not a move; a drag or a resize is, and it is saved once it settles.
    const moves = changes.filter(
      (change) =>
        change.type === "position" ||
        (change.type === "dimensions" &&
          (change.resizing !== undefined || change.setAttributes !== undefined)),
    );
    if (moves.length === 0) return;
    const [next = current] = applyNodeChanges(moves, [current]);
    const placement: KanbanPlacement = {
      x: Math.round(next.position.x),
      y: Math.round(next.position.y),
      width: Math.round(next.width ?? current.width ?? DEFAULT_KANBAN_SIZE.width),
      height: Math.round(next.height ?? current.height ?? DEFAULT_KANBAN_SIZE.height),
    };
    const moving = moves.some(
      (change) =>
        (change.type === "position" && change.dragging === true) ||
        (change.type === "dimensions" && change.resizing === true),
    );
    if (moving) setKanbanDraft({ placement });
    else saveKanban(placement);
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

  // Clicking one agent and then another connects them, first to second; a canvas click starts over.
  const linkFrom = useRef<string | null>(null);
  const onNodeClick = (event: MouseEvent, node: BoardFlowNode) => {
    if (node.type !== "agent") return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    const from = linkFrom.current;
    if (from !== null && from !== node.id) {
      addEdge(from, node.id);
      linkFrom.current = null;
    } else linkFrom.current = node.id;
  };

  const selectedNodes = () => {
    const ids = new Set(
      flow.current
        ?.getNodes()
        .filter((n) => n.selected)
        .map((n) => n.id),
    );
    return getCurrentWorkflow().nodes.filter((node) => ids.has(node.id));
  };

  const onNodeContextMenu = (event: MouseEvent, flowNode: BoardFlowNode) => {
    if (flowNode.type !== "agent") return;
    event.preventDefault();
    const node = flowNode.data.node;
    const targets = flowNode.selected ? selectedNodes() : [node];
    const many = targets.length > 1;
    const api = readLocalApi();
    if (!api) return;
    void api.contextMenu
      .show(
        [
          { id: "chat", label: "Open chat", disabled: many },
          { id: "settings", label: "Settings", disabled: many },
          { id: "rename", label: "Rename", icon: "pencil", disabled: many },
          { id: "copy", label: many ? `Copy ${targets.length} agents` : "Copy", icon: "copy" },
          {
            id: "paste",
            label: "Paste",
            disabled: !hasCopiedNodes(),
          },
          { id: "duplicate", label: "Duplicate", icon: "copy" },
          {
            id: "delete",
            label: many ? `Delete ${targets.length} agents` : "Delete",
            destructive: true,
            separatorBefore: true,
          },
        ],
        { x: event.clientX, y: event.clientY },
      )
      .then((action) => {
        switch (action) {
          case "chat":
            open("chat", node.id);
            if (node.threadId === "") void openNodeChat(node.id);
            break;
          case "settings":
            open("settings", node.id);
            break;
          case "rename":
            open("chat", node.id, { rename: true });
            break;
          case "copy":
            copyNodes(targets);
            break;
          case "paste":
            void pasteNodes();
            break;
          case "duplicate":
            void duplicateNodes(targets);
            break;
          case "delete":
            deleteNodes(targets);
            break;
        }
      });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to the window keyboard event.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, [role=dialog]"))
      )
        return;
      if (!canvas.current?.contains(target as globalThis.Node | null) && target !== document.body)
        return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (mod && (key === "y" || (key === "z" && event.shiftKey))) {
        event.preventDefault();
        redo();
      } else if (event.key === "Escape") {
        const selected = flow.current?.getNodes().filter((n) => n.selected) ?? [];
        if (selected.length === 0) return;
        onNodesChange(
          selected.map((n) => ({ type: "select" as const, id: n.id, selected: false })),
        );
      } else if (mod && key === "c") {
        const selected = selectedNodes();
        if (selected.length === 0) return;
        copyNodes(selected);
      } else if (mod && key === "v") {
        if (!hasCopiedNodes()) return;
        void pasteNodes();
      } else if (mod && key === "d") {
        const selected = selectedNodes();
        event.preventDefault();
        if (selected.length > 0) void duplicateNodes(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <SidebarInset className="h-dvh">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <BoardTitle editing={editingName} onEditingChange={setEditingName} />
      </WorkspacePageHeader>
      <div
        ref={canvas}
        className={`board-canvas relative min-h-0 flex-1${connecting ? " is-connecting" : ""}`}
      >
        <div ref={setFullScreenLayer} className="board-full-screen" />
        <div className="board-floating-controls">
          <BoardToolbar
            onRename={() => setEditingName(true)}
            onSelectRun={setSelectedRunId}
            kanbanOnBoard={kanbanFlowNode !== null}
            onKanban={onKanban}
            onAddAgent={() => setAddingAgent(true)}
          />
        </div>
        <BoardWindowsProvider
          open={open}
          close={close}
          openIds={openIds}
          fullScreen={fullScreen}
          setFullScreen={setFullScreen}
          fullScreenLayer={fullScreenLayer}
        >
          <RunViewsProvider views={views} flights={flights}>
            <ReactFlow
              className="absolute! inset-0"
              nodes={[
                ...displayedNodes,
                ...(kanbanFlowNode ? [kanbanFlowNode] : []),
                ...openWindows,
              ]}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onInit={(instance) => {
                flow.current = instance;
              }}
              onPaneClick={() => {
                linkFrom.current = null;
              }}
              onNodeDragStart={(_, node) => {
                if (node.type === "agent") recordHistoryStep();
              }}
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
          </RunViewsProvider>
        </BoardWindowsProvider>
        {selectedRun ? (
          <RunDetails run={selectedRun} onClose={() => setSelectedRunId(null)} />
        ) : null}
        {activity ? (
          <RunActivityCard
            workflow={workflow}
            target={activity}
            onClose={() => setSelectedEdgeIds(new Set())}
          />
        ) : null}
      </div>
      {addingAgent ? <AgentDialog onClose={() => setAddingAgent(false)} /> : null}
    </SidebarInset>
  );
}
