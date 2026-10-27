import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState, type RefObject } from "react";

import { FloatingPanel } from "./FloatingPanel";
import { IconButton } from "./toolbar/IconButton";
import {
  openPreviewSession,
  PersistentThreadTerminalPanel,
  PreviewPanel,
  previewEnvironment,
  primaryServerKeybindingsAtom,
  toastManager,
  useAtomCommand,
  useThreadTerminalActions,
} from "./upstream";

export type ChatTool = "terminal" | "browser";

/**
 * The thread's own terminal and browser, each in a floating window beside the chat. The terminal
 * session and the browser tab live on the server, so closing the window keeps them for next time.
 */
const TOOL_WIDTH = { browser: 520, terminal: 440 };
const GAP = 12;

/** Beside the chat: to its right, or to its left when the board has no room there. */
function besideChat(chat: HTMLElement | null, tool: ChatTool) {
  const board = chat?.offsetParent;
  if (!chat || !(board instanceof HTMLElement)) return null;
  const width = TOOL_WIDTH[tool];
  const right = chat.offsetLeft + chat.offsetWidth + GAP;
  const x = right + width <= board.clientWidth ? right : Math.max(0, chat.offsetLeft - width - GAP);
  return { x, y: chat.offsetTop };
}

/**
 * A resized sidebar moves the board, and the window with it, without any scroll or window resize,
 * which is all t3's native browser view listens to; so the board's own resizes are passed on.
 */
function followBoard(element: HTMLElement | null) {
  const board = element?.closest("aside")?.offsetParent;
  if (!element || !board) return;
  const observer = new ResizeObserver(() => element.dispatchEvent(new Event("scroll")));
  observer.observe(board);
  return () => observer.disconnect();
}

export function useChatTools(
  threadRef: ScopedThreadRef | null,
  chat: RefObject<HTMLElement | null>,
) {
  const [tool, setTool] = useState<ChatTool | null>(null);
  const [openAt, setOpenAt] = useState<{ x: number; y: number } | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const terminals = useThreadTerminalActions(threadRef);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const open = (next: ChatTool) => {
    if (tool === next) return setTool(null);
    setOpenAt(besideChat(chat.current, next));
    setTool(next);
    if (next === "terminal" && terminalId === null) {
      terminals.launchTerminal({ place: setTerminalId });
    }
    if (next === "browser" && tabId === null && threadRef) {
      void openPreviewSession({ openPreview, threadRef }).then((result) => {
        if (result._tag === "Success") return setTabId(result.value.tabId);
        setTool(null);
        toastManager.add({ type: "error", title: "Unable to open browser" });
      });
    }
  };

  const view =
    threadRef && tool ? (
      <FloatingPanel
        key={tool}
        storageKey={`board:${tool}-panel`}
        openAt={openAt}
        label={tool === "browser" ? "Browser" : "Terminal"}
        className={`top-16 right-3 max-w-[calc(100%-1.5rem)] ${
          tool === "browser" ? "h-[60%] w-[520px]" : "h-[280px] w-[440px]"
        }`}
        header={
          <>
            <span className="px-1 text-sm font-medium">
              {tool === "browser" ? "Browser" : "Terminal"}
            </span>
            <div className="flex-1" />
            <IconButton label={`Close ${tool}`} onClick={() => setTool(null)}>
              <XIcon size={15} />
            </IconButton>
          </>
        }
      >
        <div
          ref={followBoard}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl"
        >
          {tool === "terminal" && terminalId ? (
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
              onCloseTerminal={(id) => {
                terminals.closeTerminalSession(id);
                setTerminalId(null);
                setTool(null);
              }}
            />
          ) : null}
          {tool === "browser" && tabId ? (
            <PreviewPanel
              mode="embedded"
              threadRef={threadRef}
              tabId={tabId}
              configuredUrls={[]}
              visible
            />
          ) : null}
        </div>
      </FloatingPanel>
    ) : null;

  return { tool, open, view };
}
