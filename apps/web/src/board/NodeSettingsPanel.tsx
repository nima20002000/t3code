import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import ChatView from "../components/ChatView";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useProject, useThreadShells } from "../state/entities";
import { useEnvironmentIdentities } from "../state/environments";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useSendToBoardNode } from "./BoardEngine";
import {
  appendLog,
  removeNode,
  renameNode,
  setNodeRole,
  useCurrentWorkflow,
  type BoardNode,
} from "./boardStore";
import { buildBoardInstructions, connectedNodeNames, incomingNodeNames } from "./resultProtocol";

function InfoLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 gap-1.5 text-xs text-muted-foreground" title={value}>
      <span className="shrink-0">{label}</span>
      <span className="truncate text-foreground/80">{value}</span>
    </div>
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
  const { nodes, edges } = useCurrentWorkflow();
  const environments = useEnvironmentIdentities();
  const threads = useThreadShells();
  const send = useSendToBoardNode();
  const shell = threads.find(
    (thread) => thread.environmentId === node.environmentId && thread.id === node.threadId,
  );
  const project = useProject(shell ? scopeProjectRef(node.environmentId, shell.projectId) : null);
  const machine =
    environments.find((environment) => environment.environmentId === node.environmentId)?.label ??
    "Unknown";
  const [name, setName] = useState(node.name);
  const [role, setRole] = useState(node.role ?? "");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const commitName = () => {
    if (name.trim() === "") setName(node.name);
    else if (name.trim() !== node.name) renameNode(node.id, name);
  };

  const sendInstructions = async () => {
    const outgoing = connectedNodeNames(nodes, edges, node.id);
    const incoming = incomingNodeNames(nodes, edges, node.id);
    const sent = await send(node, buildBoardInstructions(node.name, outgoing, incoming));
    appendLog(
      "info",
      sent ? `Sent board instructions to ${node.name}.` : `Instructions to ${node.name} failed.`,
    );
  };

  return (
    <aside
      aria-label={`${node.name} settings`}
      className="absolute top-14 right-3 bottom-auto z-20 flex h-[70%] w-[420px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border bg-background shadow-lg"
    >
      <div className="flex shrink-0 flex-col gap-1.5 border-b p-2.5">
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
            <XIcon size={15} />
          </Button>
        </div>
        <InfoLine label="Machine" value={machine} />
        <InfoLine label="Project" value={project?.title ?? "Unknown"} />
        <InfoLine
          label="Model"
          value={
            shell ? `${shell.modelSelection.instanceId} / ${shell.modelSelection.model}` : "Unknown"
          }
        />
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Role</summary>
          <Textarea
            className="mt-1.5 min-h-9"
            rows={3}
            placeholder="What is this agent for?"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            onBlur={() => setNodeRole(node.id, role)}
          />
        </details>
        <div className="flex gap-2">
          <Button size="xs" variant="outline" onClick={() => void sendInstructions()}>
            Send board instructions
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => {
              removeNode(node.id);
              onClose();
            }}
          >
            Remove
          </Button>
        </div>
      </div>
      <div className="relative isolate flex min-h-0 min-w-0 flex-1 [transform:translateZ(0)] flex-col overflow-hidden">
        <ChatView environmentId={node.environmentId} threadId={node.threadId} routeKind="server" />
      </div>
    </aside>
  );
}
