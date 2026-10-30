import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BotIcon, PlusIcon, XIcon } from "lucide-react";
import { useStore } from "@xyflow/react";
import { useEffect, useState } from "react";

import { BoardWindowFrame, useBoardWindows, windowId, type BoardWindowProps } from "./BoardWindows";
import { useCurrentWorkflow, type BoardNode } from "./boardStore";
import {
  Button,
  closePreviewSession,
  openPreviewSession,
  PersistentThreadTerminalPanel,
  PreviewPanel,
  previewEnvironment,
  previewRuntimeTabId,
  primaryServerKeybindingsAtom,
  rendersServerTabNatively,
  toastManager,
  useAtomCommand,
  useThreadPreviewState,
  useConnectedEnvironmentIds,
  usePrimaryEnvironmentId,
  useThreadTerminalActions,
  withDesktopTab,
} from "./upstream";

/**
 * The agent's browser and terminal windows. The terminal session and the browser tabs live on the
 * server, so closing a window keeps them for next time.
 */

function tabTitle(session: PreviewSessionSnapshot) {
  const nav = session.navStatus;
  if (nav._tag === "Idle") return "New tab";
  if (nav.title) return nav.title;
  try {
    return new URL(nav.url).host || nav.url;
  } catch {
    return nav.url;
  }
}

/** The thread's tabs on the agent's machine; a desktop-only tab is out of the agent's reach. */
function useAgentTabs(threadRef: ScopedThreadRef | null) {
  return Object.values(useThreadPreviewState(threadRef).sessions).filter(
    (session) => session.runtime === "server",
  );
}

/** Opens a tab on the agent's machine, so the agent can reach it. */
function useOpenAgentTab() {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return (threadRef: ScopedThreadRef) =>
    openPreviewSession({ openPreview, threadRef, runtime: "server" }).then((result) => {
      if (result._tag === "Success") return result.value.tabId;
      toastManager.add({ type: "error", title: "Unable to open browser" });
      return null;
    });
}

/** Opens the agent's terminal and browser windows; null while it has no reachable thread. */
export function useAgentTools(node: BoardNode) {
  const windows = useBoardWindows();
  const connected = useConnectedEnvironmentIds().includes(node.environmentId);
  const threadRef = node.threadId === "" ? null : scopeThreadRef(node.environmentId, node.threadId);
  const terminals = useThreadTerminalActions(threadRef);
  const tabs = useAgentTabs(threadRef);
  const openTab = useOpenAgentTab();
  if (!threadRef || !connected) return null;
  return {
    openTerminal: () => {
      if (windows.isOpen(windowId("terminal", node.id))) return windows.open("terminal", node.id);
      terminals.launchTerminal({
        place: (terminalId) =>
          windows.open("terminal", node.id, {
            terminalId,
            terminalThreadId: threadRef.threadId,
            terminalEnvironmentId: threadRef.environmentId,
          }),
      });
    },
    openBrowser: () => {
      if (tabs.length > 0) return windows.open("browser", node.id);
      void openTab(threadRef).then((opened) => {
        if (opened) windows.open("browser", node.id);
      });
    },
  };
}

/** The agent's browser, live: it follows the tab the agent touched last unless one is picked. */
export function BrowserWindow({ id, data, selected }: BoardWindowProps) {
  const windows = useBoardWindows();
  const node = useCurrentWorkflow().nodes.find((candidate) => candidate.id === data.nodeId);
  const threadRef =
    node && node.threadId !== "" ? scopeThreadRef(node.environmentId, node.threadId) : null;
  const sessions = useAgentTabs(threadRef);
  const canvasZoom = useStore((state) => state.transform[2]);
  const openTab = useOpenAgentTab();
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const latest = (candidates: typeof sessions) =>
    candidates.reduce<(typeof sessions)[number] | null>(
      (best, session) => (best && best.updatedAt >= session.updatedAt ? best : session),
      null,
    );
  const followed = (
    latest(sessions.filter((session) => session.automationOwner !== undefined)) ?? latest(sessions)
  )?.tabId;
  // A picked tab holds until the agent moves to another one, then the window follows it again.
  const [picked, setPicked] = useState<{ tabId: string; followed: string | undefined } | null>(
    null,
  );
  const tabId =
    picked && picked.followed === followed && sessions.some((s) => s.tabId === picked.tabId)
      ? picked.tabId
      : followed;
  const shown = sessions.find((session) => session.tabId === tabId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const previewState = useThreadPreviewState(threadRef);
  const serverEpoch = previewState.serverEpoch;
  // This machine's tabs are desktop webviews laid over the page at the window's on-screen size;
  // zooming the page with the canvas keeps its layout fixed, so it scales like the rest of the board.
  const desktopTab =
    threadRef !== null &&
    shown !== undefined &&
    rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, shown)
      ? previewRuntimeTabId(threadRef, serverEpoch, shown.tabId)
      : null;
  const pageZoom = shown?.zoomFactor ?? 1;
  const scaledZoom = pageZoom * (windows.fullScreen === id ? 1 : canvasZoom);
  // t3's browser host sets the page's own zoom when its view mounts, possibly after this effect.
  const appliedZoom = shown ? previewState.desktopByTabId[shown.tabId]?.zoomFactor : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scale the desktop page with the canvas zoom.
  useEffect(() => {
    const bridge = window.desktopBridge?.preview;
    if (!desktopTab || !bridge || appliedZoom === scaledZoom) return;
    withDesktopTab(desktopTab, () => bridge.setZoomFactor(desktopTab, scaledZoom));
  }, [desktopTab, scaledZoom, appliedZoom]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Give the page its own zoom back once the board stops showing it.
  useEffect(() => {
    const bridge = window.desktopBridge?.preview;
    if (!desktopTab || !bridge) return;
    return () => withDesktopTab(desktopTab, () => bridge.setZoomFactor(desktopTab, pageZoom));
  }, [desktopTab, pageZoom]);
  if (!node || !threadRef) return null;

  const newTab = () =>
    void openTab(threadRef).then((opened) => {
      if (opened) setPicked({ tabId: opened, followed });
    });

  return (
    <BoardWindowFrame
      id={id}
      label={`${node.name} browser`}
      selected={selected}
      title={<span className="min-w-0 truncate px-1 text-sm font-medium">{node.name} browser</span>}
    >
      <div
        role="tablist"
        aria-label="Browser tabs"
        className="group/tabs flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1"
      >
        {sessions.map((session) => (
          <div
            key={session.tabId}
            className="group/tab flex max-w-44 min-w-0 shrink-0 items-center rounded text-xs text-muted-foreground hover:bg-accent has-aria-selected:bg-accent has-aria-selected:text-foreground"
          >
            <button
              type="button"
              role="tab"
              aria-selected={session.tabId === tabId}
              className="flex min-w-0 items-center gap-1.5 py-1 pl-2"
              onClick={() => setPicked({ tabId: session.tabId, followed })}
            >
              {session.automationOwner !== undefined ? (
                <BotIcon size={12} className="shrink-0" aria-label="Agent tab" />
              ) : null}
              <span className="truncate">{tabTitle(session)}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${tabTitle(session)}`}
              className="mx-1 grid size-4 shrink-0 place-items-center rounded opacity-0 group-hover/tab:opacity-100 hover:bg-background focus-visible:opacity-100"
              onClick={() =>
                void closePreviewSession({
                  closePreview,
                  snapshot: session,
                  tabId: session.tabId,
                  threadRef,
                })
              }
            >
              <XIcon size={11} />
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="New tab"
          className={`grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100 ${
            sessions.length > 0 ? "opacity-0 group-hover/tabs:opacity-100" : ""
          }`}
          onClick={newTab}
        >
          <PlusIcon size={13} />
        </button>
      </div>
      {tabId ? (
        <PreviewPanel
          mode="embedded"
          threadRef={threadRef}
          tabId={tabId}
          configuredUrls={[]}
          visible
        />
      ) : (
        <div className="grid content-start gap-3 p-4 text-sm">
          <p className="text-muted-foreground">{node.name} has no browser tab open.</p>
          <div>
            <Button size="sm" variant="outline" onClick={newTab}>
              New tab
            </Button>
          </div>
        </div>
      )}
    </BoardWindowFrame>
  );
}

/** The agent's terminal: the session the chat's Terminal button launched. */
export function TerminalWindow({ id, data, selected }: BoardWindowProps) {
  const node = useCurrentWorkflow().nodes.find((candidate) => candidate.id === data.nodeId);
  // A terminal stays with the thread it was launched in when the agent moves to a new one.
  const threadRef =
    data.terminalThreadId && data.terminalEnvironmentId
      ? scopeThreadRef(
          EnvironmentId.make(data.terminalEnvironmentId),
          ThreadId.make(data.terminalThreadId),
        )
      : node && node.threadId !== ""
        ? scopeThreadRef(node.environmentId, node.threadId)
        : null;
  const terminals = useThreadTerminalActions(threadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const windows = useBoardWindows();
  const terminalId = data.terminalId;
  if (!node || !threadRef || !terminalId) return null;
  return (
    <BoardWindowFrame
      id={id}
      label={`${node.name} terminal`}
      canFullScreen={false}
      selected={selected}
      onClose={() => {
        terminals.closeTerminalSession(terminalId);
        windows.close(id);
      }}
      title={
        <span className="min-w-0 truncate px-1 text-sm font-medium">{node.name} terminal</span>
      }
    >
      <PersistentThreadTerminalPanel
        visible
        threadRef={threadRef}
        surface={{
          id: `terminal:${terminalId}`,
          kind: "terminal",
          resourceId: terminalId,
          terminalIds: [terminalId],
          activeTerminalId: terminalId,
        }}
        launchContext={null}
        keybindings={keybindings}
        onAddTerminalContext={() => {}}
        onSplitTerminal={() => {}}
        onSplitTerminalVertical={() => {}}
        onNewTerminal={() => {}}
        onActiveTerminalChange={() => {}}
        onCloseTerminal={(closed) => {
          terminals.closeTerminalSession(closed);
          windows.close(id);
        }}
      />
    </BoardWindowFrame>
  );
}
