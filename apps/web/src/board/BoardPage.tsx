import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type PointerEvent } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { useThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { useSendToBoardNode } from "./BoardEngine";
import {
  addNode,
  appendLog,
  areConnected,
  removeNode,
  toggleEdge,
  updateNode,
  useBoardState,
  type BoardNode,
} from "./boardStore";
import { buildBoardInstructions } from "./wakeProtocol";

const CARD_WIDTH = 260;
const CARD_HEIGHT = 190;
const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const FIELD_CLASS = "h-8 rounded-md border bg-background px-2 text-sm";

function AddNodeForm() {
  const environments = useEnvironmentIdentities();
  const connectedIds = useConnectedEnvironmentIds();
  const threads = useThreadShells();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | "">("");
  const [threadId, setThreadId] = useState<ThreadId | "">("");
  const [name, setName] = useState("");
  const connected = environments.filter((environment) => connectedIds.includes(environment.environmentId));
  const environmentThreads = threads.filter(
    (thread) =>
      thread.environmentId === environmentId && thread.archivedAt === null && thread.deletedAt === null,
  );
  const environmentLabel = connected.find((env) => env.environmentId === environmentId)?.label ?? "";

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

function NodeCard(props: {
  readonly node: BoardNode;
  readonly connectFrom: string | null;
  readonly onConnectClick: (nodeId: string) => void;
}) {
  const { node, connectFrom, onConnectClick } = props;
  const navigate = useNavigate();
  const { nodes, edges } = useBoardState();
  const connectedIds = useConnectedEnvironmentIds();
  const environments = useEnvironmentIdentities();
  const threads = useThreadShells();
  const send = useSendToBoardNode();
  const drag = useRef<{ dx: number; dy: number } | null>(null);

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

  const peerNames = edges.flatMap((edge) => {
    const peerId = edge.a === node.id ? edge.b : edge.b === node.id ? edge.a : null;
    const peer = nodes.find((candidate) => candidate.id === peerId);
    return peer ? [peer.name] : [];
  });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = { dx: event.clientX - node.x, dy: event.clientY - node.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    updateNode(node.id, {
      x: Math.max(0, event.clientX - drag.current.dx),
      y: Math.max(0, event.clientY - drag.current.dy),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const sendInstructions = async () => {
    const sent = await send(node, buildBoardInstructions(node.name, peerNames));
    appendLog("info", sent ? `Sent board instructions to ${node.name}.` : `Instructions to ${node.name} failed.`);
  };

  return (
    <div
      className="absolute flex flex-col gap-1.5 rounded-lg border bg-card p-2 text-sm shadow-sm"
      style={{ left: node.x, top: node.y, width: CARD_WIDTH, height: CARD_HEIGHT }}
    >
      <div
        className="cursor-grab touch-none font-medium active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {node.name}
      </div>
      <div className="truncate text-xs text-muted-foreground">{environmentLabel}</div>
      <div className="truncate text-xs">{shell?.title ?? "Thread not found"}</div>
      <div className="text-xs text-muted-foreground">Status: {status}</div>
      <div className="mt-auto flex flex-wrap gap-1">
        <Button
          size="xs"
          variant={connectFrom === node.id ? "default" : "outline"}
          onClick={() => onConnectClick(node.id)}
        >
          {connectFrom === null ? "Connect" : connectFrom === node.id ? "Cancel" : "Connect here"}
        </Button>
        <Button size="xs" variant="outline" onClick={sendInstructions}>
          Send board instructions
        </Button>
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
        <Button size="xs" variant="ghost-destructive" onClick={() => removeNode(node.id)}>
          Remove
        </Button>
      </div>
    </div>
  );
}

export function BoardPage() {
  const { nodes, edges, log, pending } = useBoardState();
  const [connectFrom, setConnectFrom] = useState<string | null>(null);

  const onConnectClick = (nodeId: string) => {
    if (connectFrom === null) {
      setConnectFrom(nodeId);
      return;
    }
    if (connectFrom !== nodeId && !areConnected(connectFrom, nodeId)) toggleEdge(connectFrom, nodeId);
    setConnectFrom(null);
  };

  return (
    <SidebarInset className="h-dvh">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-medium">Board</h1>
        <AddNodeForm />
        <span className="text-xs text-muted-foreground">{pending.length} pending</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-auto">
          <svg className="pointer-events-none absolute inset-0 h-full min-h-[2000px] w-full min-w-[3000px]">
            {edges.map((edge) => {
              const a = nodes.find((node) => node.id === edge.a);
              const b = nodes.find((node) => node.id === edge.b);
              if (!a || !b) return null;
              return (
                <line
                  key={`${edge.a}:${edge.b}`}
                  x1={a.x + CARD_WIDTH / 2}
                  y1={a.y + CARD_HEIGHT / 2}
                  x2={b.x + CARD_WIDTH / 2}
                  y2={b.y + CARD_HEIGHT / 2}
                  stroke="currentColor"
                  strokeWidth={2}
                  className="text-muted-foreground"
                />
              );
            })}
          </svg>
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              connectFrom={connectFrom}
              onConnectClick={onConnectClick}
            />
          ))}
        </div>
        <aside className="flex w-72 shrink-0 flex-col border-l">
          <div className="border-b px-3 py-2 text-sm font-medium">Activity</div>
          <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 text-xs">
            {log.length === 0 ? <p className="text-muted-foreground">No activity yet.</p> : null}
            {log.map((entry) => (
              <div key={entry.id}>
                <div className="text-muted-foreground">
                  {new Date(entry.at).toLocaleTimeString()} · {entry.kind}
                </div>
                <div className="line-clamp-4 whitespace-pre-wrap">{entry.text}</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </SidebarInset>
  );
}
