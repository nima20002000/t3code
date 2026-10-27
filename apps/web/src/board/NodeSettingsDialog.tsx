import { useState } from "react";

import ChatView from "../components/ChatView";
import { Button } from "../components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
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

function ReadOnly({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate rounded-md border bg-muted/40 px-2 py-1.5" title={value}>
        {value}
      </span>
    </div>
  );
}

/**
 * Node settings plus t3's own ChatView for the node's thread (the same component the thread route
 * renders, driven by props only), so the conversation can be used without leaving the board.
 */
export function NodeSettingsDialog(props: {
  readonly node: BoardNode;
  readonly onClose: () => void;
}) {
  const { node } = props;
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        className="h-[80vh] w-[80vw] max-w-none sm:max-w-none"
        bottomStickOnMobile={false}
      >
        <DialogTitle className="sr-only">{node.name} settings</DialogTitle>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid shrink-0 gap-3 border-b p-4 pe-14 md:grid-cols-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Name</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </label>
            <ReadOnly label="Machine" value={machine} />
            <ReadOnly label="Project" value={project?.title ?? "Unknown"} />
            <ReadOnly
              label="Provider / model"
              value={
                shell
                  ? `${shell.modelSelection.instanceId} / ${shell.modelSelection.model}`
                  : "Unknown"
              }
            />
            <label className="flex flex-col gap-1 text-sm md:col-span-3">
              <span className="text-muted-foreground">Role</span>
              <Textarea
                className="min-h-9"
                rows={2}
                placeholder="What is this agent for?"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                onBlur={() => setNodeRole(node.id, role)}
              />
            </label>
            <div className="flex items-end justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => void sendInstructions()}>
                Send board instructions
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() => {
                  removeNode(node.id);
                  props.onClose();
                }}
              >
                Remove node
              </Button>
            </div>
          </div>
          <div className="relative isolate flex min-h-[320px] min-w-0 flex-1 flex-col overflow-hidden">
            <ChatView
              environmentId={node.environmentId}
              threadId={node.threadId}
              routeKind="server"
            />
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
