import { SettingsIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AgentDialog } from "./AddAgentDialog";
import { FloatingPanel } from "./FloatingPanel";
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

  return (
    <FloatingPanel
      storageKey="board:chat-panel"
      label={`${node.name} chat`}
      className="top-16 right-3 h-[70%] w-[420px] max-w-[calc(100%-1.5rem)]"
      header={
        <>
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
        </>
      }
    >
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
    </FloatingPanel>
  );
}
