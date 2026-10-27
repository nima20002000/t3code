import { SettingsIcon, XIcon } from "lucide-react";
import { useEffect, useState, type PointerEvent } from "react";
import { Link } from "@tanstack/react-router";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AgentDialog } from "./AddAgentDialog";
import { IconButton } from "./toolbar/IconButton";
import { useSendBoardInstructions } from "./useSendBoardInstructions";
import {
  openNodeChat,
  removeNode,
  renameNode,
  useCurrentWorkflow,
  useBoardPeers,
  type BoardNode,
} from "./boardStore";
import {
  buildAgentInstructions,
  connectedNodeNames,
  incomingNodeNames,
} from "@t3tools/board-core/resultProtocol";
import {
  Button,
  ChatView,
  Input,
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  useRightPanelStore,
} from "./upstream";

const PANEL_POSITION_KEY = "board:chat-panel-position";
type PanelPosition = { readonly x: number; readonly y: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
function readPanelPosition(): PanelPosition | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PANEL_POSITION_KEY) ?? "null");
    return value && typeof value === "object" && "x" in value && "y" in value
      ? { x: Number(value.x), y: Number(value.y) }
      : null;
  } catch {
    return null;
  }
}
function savePanelPosition(position: PanelPosition) {
  try {
    localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify(position));
  } catch {
    // Storage can be unavailable; the panel just opens at its default spot next time.
  }
}

const PANEL_SIZE_KEY = "board:chat-panel-size";
const MIN_PANEL = { w: 320, h: 260 };
type PanelSize = { readonly w: number; readonly h: number };
function readPanelSize(): PanelSize | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) ?? "null");
    return value && typeof value === "object" && "w" in value && "h" in value
      ? { w: Number(value.w), h: Number(value.h) }
      : null;
  } catch {
    return null;
  }
}
function savePanelSize(size: PanelSize) {
  try {
    localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(size));
  } catch {
    // Storage can be unavailable; the panel just opens at its default size next time.
  }
}
type ResizeEdges = { readonly left?: boolean; readonly right?: boolean; readonly bottom?: boolean };
const RESIZE_HANDLES: ReadonlyArray<{ readonly edges: ResizeEdges; readonly className: string }> = [
  { edges: { left: true }, className: "inset-y-3 -left-1 w-2 cursor-ew-resize" },
  { edges: { right: true }, className: "inset-y-3 -right-1 w-2 cursor-ew-resize" },
  { edges: { bottom: true }, className: "inset-x-3 -bottom-1 h-2 cursor-ns-resize" },
  { edges: { left: true, bottom: true }, className: "-bottom-1 -left-1 size-4 cursor-nesw-resize" },
  {
    edges: { right: true, bottom: true },
    className: "-right-1 -bottom-1 size-4 cursor-nwse-resize",
  },
];

/** The agent dialog in edit mode, with remove and send-instructions; used by the panel and the node. */
export function AgentSettingsDialog(props: {
  readonly node: BoardNode;
  readonly onClose: () => void;
  readonly onRemoved?: () => void;
}) {
  const { node } = props;
  const { nodes, edges } = useCurrentWorkflow();
  const send = useSendBoardInstructions();
  return (
    <AgentDialog
      node={node}
      onClose={props.onClose}
      onSendInstructions={() =>
        void send(
          node,
          buildAgentInstructions({
            name: node.name,
            profile: node.profile,
            prompt: node.prompt,
            outgoing: connectedNodeNames(nodes, edges, node.id),
            incoming: incomingNodeNames(nodes, edges, node.id),
          }),
        )
      }
      onRemove={() => {
        removeNode(node.id);
        props.onClose();
        props.onRemoved?.();
      }}
    />
  );
}

/**
 * Non-modal floating panel docked inside the board: node settings plus t3's own ChatView for the node's thread (the same component the thread route
 * renders, driven by props only), so the conversation can be used without leaving the board.
 */
export function NodeSettingsPanel(props: {
  readonly node: BoardNode;
  readonly onClose: () => void;
}) {
  const { node, onClose } = props;
  const environments = useEnvironmentIdentities();
  const connectedIds = useConnectedEnvironmentIds();
  const peers = useBoardPeers();
  const machine =
    environments.find((environment) => environment.environmentId === node.environmentId)?.label ??
    peers.find((peer) => peer.environmentId === node.environmentId)?.name ??
    "Unknown";
  const [name, setName] = useState(node.name);
  const [editingName, setEditingName] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [position, setPosition] = useState(readPanelPosition);
  const [size, setSize] = useState(readPanelSize);

  // The panel is too narrow for t3's right panel; start each node's chat with it closed.
  // oxlint-disable-next-line t3code/react-effect-budget -- Synchronize the external right-panel store with the active thread.
  useEffect(() => {
    useRightPanelStore.getState().close(scopeThreadRef(node.environmentId, node.threadId));
  }, [node.environmentId, node.threadId]);

  // oxlint-disable-next-line t3code/react-effect-budget -- Subscribe to the window keyboard event.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const commitName = () => {
    setEditingName(false);
    if (name.trim() !== "" && name.trim() !== node.name) renameNode(node.id, name);
  };

  // Drag by the header's empty space; the spot is kept per viewer.
  const startMove = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("button, input, [role=menu]"))
    )
      return;
    const panel = event.currentTarget.parentElement;
    const board = panel?.offsetParent;
    if (!panel || !(board instanceof HTMLElement)) return;
    const startX = event.clientX - panel.offsetLeft;
    const startY = event.clientY - panel.offsetTop;
    const header = event.currentTarget;
    header.setPointerCapture(event.pointerId);
    let next = position;
    const move = (moveEvent: globalThis.PointerEvent) => {
      next = {
        x: clamp(moveEvent.clientX - startX, 0, board.clientWidth - panel.offsetWidth),
        y: clamp(moveEvent.clientY - startY, 0, board.clientHeight - 40),
      };
      setPosition(next);
    };
    const end = () => {
      header.removeEventListener("pointermove", move);
      header.removeEventListener("pointerup", end);
      header.removeEventListener("pointercancel", end);
      if (next) savePanelPosition(next);
    };
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", end);
    header.addEventListener("pointercancel", end);
  };

  // Resize from an edge or corner; the panel is pinned to left/top first so its left edge can move.
  const startResize = (edges: ResizeEdges) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const panel = handle.parentElement;
    const board = panel?.offsetParent;
    if (!panel || !(board instanceof HTMLElement)) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: panel.offsetLeft,
      top: panel.offsetTop,
      w: panel.offsetWidth,
      h: panel.offsetHeight,
    };
    let nextSize: PanelSize = { w: start.w, h: start.h };
    let nextPosition: PanelPosition = { x: start.left, y: start.top };
    const move = (moveEvent: globalThis.PointerEvent) => {
      const dx = moveEvent.clientX - start.x;
      const dy = moveEvent.clientY - start.y;
      let { w, h } = { w: start.w, h: start.h };
      let x = start.left;
      if (edges.right) w = clamp(start.w + dx, MIN_PANEL.w, board.clientWidth - start.left);
      if (edges.left) {
        w = clamp(start.w - dx, MIN_PANEL.w, start.left + start.w);
        x = start.left + start.w - w;
      }
      if (edges.bottom) h = clamp(start.h + dy, MIN_PANEL.h, board.clientHeight - start.top);
      nextSize = { w, h };
      nextPosition = { x, y: start.top };
      setSize(nextSize);
      setPosition(nextPosition);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      savePanelSize(nextSize);
      savePanelPosition(nextPosition);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <aside
      aria-label={`${node.name} chat`}
      className="board-chat-panel absolute top-16 right-3 bottom-auto z-20 flex h-[70%] w-[420px] max-w-[calc(100%-1.5rem)] flex-col rounded-xl border bg-background shadow-lg"
      style={{
        ...(position ? { left: position.x, top: position.y, right: "auto" } : {}),
        ...(size ? { width: size.w, height: size.h, maxWidth: "none" } : {}),
      }}
    >
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.className}
          aria-hidden
          className={`absolute z-30 ${handle.className}`}
          onPointerDown={startResize(handle.edges)}
        />
      ))}
      <div
        className="flex shrink-0 cursor-grab items-center gap-1 border-b py-1.5 pr-1.5 pl-2.5 active:cursor-grabbing"
        onPointerDown={startMove}
      >
        {editingName ? (
          <Input
            size="sm"
            aria-label="Name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.stopPropagation();
                setName(node.name);
                setEditingName(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 truncate rounded px-1 text-left text-sm font-medium hover:bg-accent"
            onClick={() => {
              setName(node.name);
              setEditingName(true);
            }}
          >
            {node.name}
          </button>
        )}
        <div className="flex-1" />
        <IconButton label={`${node.name} settings`} onClick={() => setConfiguring(true)}>
          <SettingsIcon size={15} />
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <XIcon size={15} />
        </IconButton>
      </div>
      {configuring ? (
        <AgentSettingsDialog
          node={node}
          onClose={() => setConfiguring(false)}
          onRemoved={onClose}
        />
      ) : null}
      <div className="relative isolate flex min-h-0 min-w-0 flex-1 rounded-b-xl [transform:translateZ(0)] flex-col overflow-hidden">
        {node.threadId === "" ? (
          <div className="grid content-start gap-3 p-4 text-sm">
            <p className="text-muted-foreground">{node.name} has no chat yet.</p>
            <div>
              <Button size="sm" variant="outline" onClick={() => void openNodeChat(node.id)}>
                Start chat
              </Button>
            </div>
          </div>
        ) : connectedIds.includes(node.environmentId) ? (
          <ChatView
            environmentId={node.environmentId}
            threadId={node.threadId}
            routeKind="server"
          />
        ) : (
          <div className="grid content-start gap-3 p-4 text-sm">
            <p>Connect {machine} in Connections to view and use this thread.</p>
            <div>
              <Button size="sm" variant="outline" render={<Link to="/settings/connections" />}>
                Connections
              </Button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
