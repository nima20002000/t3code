import { useEffect, useEffectEvent, useState } from "react";
import { Link } from "@tanstack/react-router";

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AgentDialog } from "./AddAgentDialog";
import { BoardWindowFrame, useBoardWindows, windowId, type BoardWindowProps } from "./BoardWindows";
import { useSendBoardInstructions } from "./useSendBoardInstructions";
import {
  newNodeChat,
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
  ComposerHandleContext,
  type ComposerHandleRef,
  ComposerNewThreadContext,
  type ComposerNewThreadSettings,
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePreviewMiniPlayerStore,
  useRightPanelStore,
} from "./upstream";

/** The agent's settings window: the agent form in edit mode, with remove and send-instructions. */
export function AgentSettingsWindow({ id, data, selected }: BoardWindowProps) {
  const { nodes, edges } = useCurrentWorkflow();
  const send = useSendBoardInstructions();
  const windows = useBoardWindows();
  const node = nodes.find((candidate) => candidate.id === data.nodeId);
  if (!node) return null;
  return (
    <BoardWindowFrame
      id={id}
      label={`${node.name} settings`}
      canFullScreen={false}
      selected={selected}
      title={
        <span className="min-w-0 truncate px-1 text-sm font-medium">{node.name} settings</span>
      }
    >
      <AgentDialog
        key={node.id}
        node={node}
        onClose={() => windows.close(id)}
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
        onRemove={() => removeNode(node.id)}
      />
    </BoardWindowFrame>
  );
}

/**
 * The agent's chat window: t3's own ChatView for the node's thread (the same component the thread
 * route renders, driven by props only), so the conversation can be used without leaving the board.
 */
export function ChatWindow({ id, data, selected }: BoardWindowProps) {
  const node = useCurrentWorkflow().nodes.find((candidate) => candidate.id === data.nodeId);
  return node ? (
    <ChatWindowBody id={id} node={node} selected={selected} rename={data.rename ?? false} />
  ) : null;
}

function ChatWindowBody(props: {
  readonly id: string;
  readonly node: BoardNode;
  readonly selected: boolean;
  readonly rename: boolean;
}) {
  const { node } = props;
  const windows = useBoardWindows();
  const environments = useEnvironmentIdentities();
  const connectedIds = useConnectedEnvironmentIds();
  const peers = useBoardPeers();
  const machine =
    environments.find((environment) => environment.environmentId === node.environmentId)?.label ??
    peers.find((peer) => peer.environmentId === node.environmentId)?.name ??
    "Unknown";
  const [name, setName] = useState(node.name);
  const [editingName, setEditingName] = useState(props.rename);
  // Each chat window has its own composer; the app-wide handle belongs to the routed chat.
  const [composerHandle] = useState<ComposerHandleRef>(() => ({ current: null }));

  const showBrowser = useEffectEvent(() => {
    if (!windows.isOpen(windowId("browser", node.id))) windows.open("browser", node.id);
  });
  // The chat is too narrow for t3's right panel and floating browser; a page the agent opens
  // there goes to the agent's browser window on the board instead.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize the external panel stores with the active thread.
  useEffect(() => {
    const threadRef = scopeThreadRef(node.environmentId, node.threadId);
    const threadKey = scopedThreadKey(threadRef);
    useRightPanelStore.getState().close(threadRef);
    const redirect = () => {
      const miniPlayer = usePreviewMiniPlayerStore.getState();
      const panels = useRightPanelStore.getState();
      const panel = panels.byThreadKey[threadKey];
      const previewInPanel =
        panel?.isOpen === true &&
        panel.surfaces.some(
          (surface) => surface.id === panel.activeSurfaceId && surface.kind === "preview",
        );
      if (!miniPlayer.byThreadKey[threadKey] && !previewInPanel) return;
      if (miniPlayer.byThreadKey[threadKey]) miniPlayer.close(threadRef);
      if (previewInPanel) panels.close(threadRef);
      showBrowser();
    };
    redirect();
    const stopMiniPlayer = usePreviewMiniPlayerStore.subscribe(redirect);
    const stopPanels = useRightPanelStore.subscribe(redirect);
    return () => {
      stopMiniPlayer();
      stopPanels();
    };
  }, [node.environmentId, node.threadId]);

  const commitName = () => {
    setEditingName(false);
    if (name.trim() !== "" && name.trim() !== node.name) renameNode(node.id, name);
  };
  const connected = connectedIds.includes(node.environmentId);
  const startNewChat = (settings: ComposerNewThreadSettings) => newNodeChat(node.id, settings);
  return (
    <BoardWindowFrame
      id={props.id}
      label={`${node.name} chat`}
      selected={props.selected}
      title={
        editingName ? (
          <div className="nodrag min-w-0">
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
          </div>
        ) : (
          <button
            type="button"
            className="nodrag min-w-0 truncate rounded px-1 text-left text-sm font-medium hover:bg-accent"
            onClick={() => {
              setName(node.name);
              setEditingName(true);
            }}
          >
            {node.name}
          </button>
        )
      }
    >
      <div className="relative isolate flex min-h-0 min-w-0 flex-1 [transform:translateZ(0)] flex-col overflow-hidden">
        {node.threadId === "" ? (
          <div className="grid content-start gap-3 p-4 text-sm">
            <p className="text-muted-foreground">{node.name} has no chat yet.</p>
            <div>
              <Button size="sm" variant="outline" onClick={() => void openNodeChat(node.id)}>
                Start chat
              </Button>
            </div>
          </div>
        ) : connected ? (
          <ComposerHandleContext value={composerHandle}>
            <ComposerNewThreadContext value={startNewChat}>
              <ChatView
                environmentId={node.environmentId}
                threadId={node.threadId}
                routeKind="server"
              />
            </ComposerNewThreadContext>
          </ComposerHandleContext>
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
    </BoardWindowFrame>
  );
}
