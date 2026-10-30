import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";

import { agentNodeSize } from "./foreman/signalEdge";
import { IconButton } from "./toolbar/IconButton";
import type { BoardNode } from "./boardStore";

export type BoardWindowKind = "chat" | "browser" | "terminal" | "settings";

/** An agent's chat, browser, terminal or settings, as an object on the canvas beside the agent. */
export type WindowFlowNode = Node<
  { readonly kind: BoardWindowKind; readonly nodeId: string } & WindowOptions,
  "window"
>;
export type WindowOptions = {
  /** Chat opens with its name being edited. */
  readonly rename?: boolean;
  /** The terminal session a terminal window shows, and the thread it was launched in. */
  readonly terminalId?: string;
  readonly terminalThreadId?: string;
  readonly terminalEnvironmentId?: string;
};

export const windowId = (kind: BoardWindowKind, nodeId: string) => `${kind}:${nodeId}`;

export interface BoardWindows {
  readonly open: (kind: BoardWindowKind, nodeId: string, options?: WindowOptions) => void;
  readonly close: (id: string) => void;
  readonly isOpen: (id: string) => boolean;
  /** The window shown full screen over the board, if any. */
  readonly fullScreen: string | null;
  readonly setFullScreen: (id: string | null) => void;
  /** Where a full-screen window renders: a layer over the whole board. */
  readonly fullScreenLayer: HTMLElement | null;
}

export const BoardWindowsContext = createContext<BoardWindows>({
  open: () => {},
  close: () => {},
  isOpen: () => false,
  fullScreen: null,
  setFullScreen: () => {},
  fullScreenLayer: null,
});

export const useBoardWindows = () => useContext(BoardWindowsContext);

/**
 * Every window and agent reads this context while windows move every frame of a drag, so its
 * value is built here from inputs that change only when a window opens, closes or goes full screen.
 */
export function BoardWindowsProvider(props: {
  readonly open: BoardWindows["open"];
  readonly close: BoardWindows["close"];
  /** Open window ids, one per line. */
  readonly openIds: string;
  readonly fullScreen: string | null;
  readonly setFullScreen: BoardWindows["setFullScreen"];
  readonly fullScreenLayer: HTMLElement | null;
  readonly children: ReactNode;
}) {
  const { openIds, fullScreen } = props;
  const value: BoardWindows = {
    open: props.open,
    close: props.close,
    isOpen: (id) => openIds.split("\n").includes(id),
    fullScreen: fullScreen !== null && openIds.split("\n").includes(fullScreen) ? fullScreen : null,
    setFullScreen: props.setFullScreen,
    fullScreenLayer: props.fullScreenLayer,
  };
  return (
    <BoardWindowsContext.Provider value={value}>{props.children}</BoardWindowsContext.Provider>
  );
}

const WINDOW_SIZE: Record<BoardWindowKind, { readonly width: number; readonly height: number }> = {
  chat: { width: 440, height: 600 },
  browser: { width: 640, height: 480 },
  terminal: { width: 520, height: 320 },
  settings: { width: 420, height: 600 },
};
const GAP = 48;

/** Where a new window goes: centered below its agent, under any windows already in that spot. */
export function newWindowNode(
  kind: BoardWindowKind,
  node: BoardNode,
  open: ReadonlyArray<WindowFlowNode>,
  options: WindowOptions = {},
): WindowFlowNode {
  const { width, height } = WINDOW_SIZE[kind];
  const size = agentNodeSize(node);
  const widthOf = (window: WindowFlowNode) => window.width ?? WINDOW_SIZE[window.data.kind].width;
  // The agent's first window goes under it; each later one beside the one opened before it.
  const previous = open.findLast((window) => window.data.nodeId === node.id);
  const position = previous
    ? { x: previous.position.x + widthOf(previous) + GAP / 2, y: previous.position.y }
    : { x: node.x + size / 2 - width / 2, y: node.y + size + GAP };
  for (let moved = true; moved;) {
    moved = false;
    for (const window of open) {
      const right = window.position.x + widthOf(window);
      const bottom = window.position.y + (window.height ?? WINDOW_SIZE[window.data.kind].height);
      const overlaps =
        position.x < right &&
        window.position.x < position.x + width &&
        position.y < bottom &&
        window.position.y < position.y + height;
      if (!overlaps) continue;
      if (previous) position.x = right + GAP / 2;
      else position.y = bottom + GAP / 2;
      moved = true;
    }
  }
  return windowNode(
    { kind, nodeId: node.id, x: position.x, y: position.y, width, height },
    options,
  );
}

type SavedWindow = {
  readonly kind: BoardWindowKind;
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly terminalId?: string;
  readonly terminalThreadId?: string;
  readonly terminalEnvironmentId?: string;
};

function windowNode(saved: SavedWindow, options: WindowOptions = {}): WindowFlowNode {
  return {
    id: windowId(saved.kind, saved.nodeId),
    type: "window",
    position: { x: saved.x, y: saved.y },
    width: saved.width,
    height: saved.height,
    zIndex: 10,
    dragHandle: ".board-window-header",
    data: {
      kind: saved.kind,
      nodeId: saved.nodeId,
      ...(saved.terminalId ? { terminalId: saved.terminalId } : {}),
      ...(saved.terminalThreadId ? { terminalThreadId: saved.terminalThreadId } : {}),
      ...(saved.terminalEnvironmentId
        ? { terminalEnvironmentId: saved.terminalEnvironmentId }
        : {}),
      ...options,
    },
  };
}

const windowsKey = (workflowId: string) => `board-windows:${workflowId}`;

function isSavedWindow(value: unknown): value is SavedWindow {
  if (typeof value !== "object" || value === null) return false;
  const saved = value as Record<string, unknown>;
  return (
    typeof saved.kind === "string" &&
    saved.kind in WINDOW_SIZE &&
    typeof saved.nodeId === "string" &&
    [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) &&
    (saved.terminalId === undefined || typeof saved.terminalId === "string") &&
    (saved.terminalThreadId === undefined || typeof saved.terminalThreadId === "string") &&
    (saved.terminalEnvironmentId === undefined || typeof saved.terminalEnvironmentId === "string")
  );
}

/** Open windows are this viewer's layout, so they're kept in the browser, per workflow. */
export function loadWindows(workflowId: string): WindowFlowNode[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(windowsKey(workflowId)) ?? "[]");
    return Array.isArray(value)
      ? value.filter(isSavedWindow).map((saved) => windowNode(saved))
      : [];
  } catch {
    return [];
  }
}

export function saveWindows(workflowId: string, windows: ReadonlyArray<WindowFlowNode>) {
  const saved = windows.map((window): SavedWindow => ({
    kind: window.data.kind,
    nodeId: window.data.nodeId,
    x: window.position.x,
    y: window.position.y,
    width: window.width ?? WINDOW_SIZE[window.data.kind].width,
    height: window.height ?? WINDOW_SIZE[window.data.kind].height,
    ...(window.data.terminalId ? { terminalId: window.data.terminalId } : {}),
    ...(window.data.terminalThreadId ? { terminalThreadId: window.data.terminalThreadId } : {}),
    ...(window.data.terminalEnvironmentId
      ? { terminalEnvironmentId: window.data.terminalEnvironmentId }
      : {}),
  }));
  try {
    localStorage.setItem(windowsKey(workflowId), JSON.stringify(saved));
  } catch {
    // Storage can be unavailable; windows then just close on reload.
  }
}

/**
 * The frame every board window shares: a header to drag it by, a close button, and a body that
 * keeps its own pointer, wheel and keys, so chatting or scrolling never moves the canvas.
 */
export function BoardWindowFrame(props: {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
  readonly title: ReactNode;
  readonly actions?: ReactNode;
  readonly onClose?: () => void;
  readonly canFullScreen?: boolean;
  readonly children: ReactNode;
}) {
  const windows = useBoardWindows();
  const fullScreen = windows.fullScreen === props.id ? windows.fullScreenLayer : null;
  const section = useRef<HTMLElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  // The frame renders into its own element, moved between the canvas and the full-screen layer,
  // so going full screen doesn't remount the chat.
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "size-full";
    return element;
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Moves the frame's element between the canvas and the full-screen layer.
  useLayoutEffect(() => {
    const target = fullScreen ?? slot.current;
    if (!target) return;
    // A plain append reloads embedded frames and drops focus; moveBefore keeps them.
    try {
      if (host.isConnected && "moveBefore" in target) {
        target.moveBefore(host, null);
        return;
      }
    } catch {
      // Not movable this way (another document, say); a plain append still works.
    }
    target.append(host);
  }, [fullScreen, host]);
  // oxlint-disable-next-line t3code/react-effect-budget -- Removes the frame's element with the window.
  useLayoutEffect(() => () => host.remove(), [host]);
  const toggleFullScreen = () =>
    void requestFullScreen(
      fullScreen ? null : props.id,
      windows.fullScreenLayer,
      windows.setFullScreen,
    );
  const frame = (
    <section
      ref={section}
      aria-label={props.label}
      className="board-window"
      data-window-id={props.id}
      data-selected={props.selected || undefined}
      data-full-screen={fullScreen ? true : undefined}
    >
      {fullScreen ? (
        <div
          aria-hidden
          className="h-(--native-titlebar-height) shrink-0"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        />
      ) : (
        <NodeResizer minWidth={280} minHeight={180} />
      )}
      <div className="board-window-header">
        {props.title}
        <div className="flex-1" />
        {props.actions}
        {props.canFullScreen === false ? null : (
          <IconButton
            label={fullScreen ? "Exit full screen" : "Full screen"}
            onClick={toggleFullScreen}
          >
            {fullScreen ? <Minimize2Icon size={15} /> : <Maximize2Icon size={15} />}
          </IconButton>
        )}
        <IconButton
          label={`Close ${props.label}`}
          onClick={props.onClose ?? (() => windows.close(props.id))}
        >
          <XIcon size={15} />
        </IconButton>
      </div>
      <div className="nodrag nopan nowheel nokey relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl">
        {props.children}
      </div>
    </section>
  );
  return (
    <>
      <div ref={slot} className="size-full" />
      {createPortal(frame, host)}
    </>
  );
}

const FADE_MS = 240;
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const windowSection = (id: string) =>
  document.querySelector<HTMLElement>(`section[data-window-id="${CSS.escape(id)}"]`);
let wanted: string | null = null;
let changing = false;

/**
 * Moves full screen to the window last asked for (null: back to the board), one change at a time,
 * so a quick second request is honoured once the first lands and a closed window is skipped.
 */
export async function requestFullScreen(
  id: string | null,
  layer: HTMLElement | null,
  apply: (id: string | null) => void,
) {
  wanted = id;
  if (changing || !layer) {
    if (!layer) apply(id);
    return;
  }
  changing = true;
  try {
    for (;;) {
      const from = layer.querySelector<HTMLElement>("section[data-window-id]")?.dataset.windowId;
      const shown = from ?? null;
      const to = wanted === null || windowSection(wanted) ? wanted : shown;
      if (to === shown) break;
      await changeFullScreen(shown, to, apply);
    }
  } finally {
    changing = false;
  }
}

/**
 * One change through a blur of the board. Resizing re-lays out the whole chat and blocks the main
 * thread, so it happens once the windows involved have faded out; the fades and the blur run on
 * the compositor and keep moving through it.
 */
async function changeFullScreen(
  from: string | null,
  to: string | null,
  apply: (id: string | null) => void,
) {
  const ids = [from, to].filter((id) => id !== null);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    flushSync(() => apply(to));
    return;
  }
  const owned: Animation[] = [];
  const fade = (element: Element, opacity: number, duration = FADE_MS) => {
    const animation = element.animate(
      [{ opacity: Number(getComputedStyle(element).opacity) }, { opacity }],
      { duration, easing: "ease-out", fill: "forwards" },
    );
    owned.push(animation);
    return animation.finished;
  };
  // Drawn above the app or above the blur, so they fade with the windows: native browser pages
  // and the board's controls.
  const chrome = () => [
    ...[...document.querySelectorAll<HTMLElement>("[data-electron-browser-host] > *")].filter(
      (view) => view.style.zIndex !== "-1",
    ),
    ...document.querySelectorAll<HTMLElement>(".board-floating-controls"),
  ];
  const sections = () => ids.map(windowSection).filter((section) => section !== null);
  const backdrop = document.createElement("div");
  try {
    backdrop.className = "board-panel-backdrop";
    backdrop.style.opacity = from === null ? "0" : "1";
    document.body.append(backdrop);
    // Timelines at their end go back there once their window has its new size.
    const atEnd = sections()
      .flatMap((section) => [...section.querySelectorAll<HTMLElement>(".messages-timeline-scroll")])
      .filter((scroller) => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4);
    let blur = from === null ? fade(backdrop, 1, FADE_MS * 2) : null;
    await Promise.all([...sections(), ...chrome()].map((element) => fade(element, 0)));
    if (to === null) {
      blur = fade(backdrop, 0, FADE_MS * 2);
      await nextFrame();
      await nextFrame();
    }
    // A window closed during the fade isn't brought back.
    flushSync(() => apply(to === null || windowSection(to) ? to : from));
    // The chat re-renders once it observes its new size; let that settle before revealing it.
    await nextFrame();
    await nextFrame();
    for (const scroller of atEnd) scroller.scrollTop = scroller.scrollHeight;
    await Promise.all([...[...sections(), ...chrome()].map((element) => fade(element, 1)), blur]);
  } finally {
    for (const animation of owned) animation.cancel();
    backdrop.remove();
  }
}

export type BoardWindowProps = NodeProps<WindowFlowNode>;

type Box = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};
const intersect = (a: Box, b: Box): Box => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});
const hasArea = (box: Box) => box.right > box.left && box.bottom > box.top;

/** What's left of `box` outside every cover, as disjoint rectangles. */
function coveredBy(box: Box, covers: ReadonlyArray<Box>): Box[] {
  let parts = hasArea(box) ? [box] : [];
  for (const cover of covers) {
    parts = parts.flatMap((part) => {
      const cut = intersect(part, cover);
      if (!hasArea(cut)) return [part];
      return [
        { ...part, bottom: cut.top },
        { ...part, top: cut.bottom },
        { left: part.left, top: cut.top, right: cut.left, bottom: cut.bottom },
        { left: cut.right, top: cut.top, right: part.right, bottom: cut.bottom },
      ].filter(hasArea);
    });
  }
  return parts;
}

/**
 * t3's composer menu is fixed on the page and placed again only on a scroll, so a pan or a moved
 * window would leave it behind; a scroll event from the board places it on its composer again.
 */
export function followComposerMenus(canvas: HTMLElement) {
  const moved = new MutationObserver((records) => {
    if (!document.querySelector("[data-composer-drawer-layer]")) return;
    if (
      records.some(
        ({ target }) =>
          target instanceof Element && target.matches(".react-flow__viewport, .react-flow__node"),
      )
    ) {
      canvas.dispatchEvent(new Event("scroll"));
    }
  });
  moved.observe(canvas, { subtree: true, attributeFilter: ["style"] });
  return () => moved.disconnect();
}

/**
 * Native browser views sit in a fixed layer above the app, placed from a rect upstream reads only
 * on scroll. A board window's view is placed on its slot as soon as the board moves, before paint,
 * clipped to its window and to what the board draws over it, and hidden under another full-screen
 * window.
 */
export function syncNativeViews(canvas: HTMLElement, fullScreenLayer: HTMLElement) {
  let host: Element | null = null;
  const views = () =>
    host ? [...host.children].filter((view) => view instanceof HTMLElement) : [];
  const owned = new Set<HTMLElement>();
  // What the board draws over a page: nodes stacked above its window, and the panels floating over
  // the board (the toolbar is already above the pages).
  const coversOf = (slot: Element) => {
    const node = slot.closest(".react-flow__node");
    const covers: Element[] = [
      ...canvas.querySelectorAll(
        ":scope > :not(.board-full-screen, .board-floating-controls, .react-flow, .react-flow__node)",
      ),
    ];
    if (node instanceof HTMLElement) {
      const z = Number(node.style.zIndex) || 0;
      let later = false;
      for (const other of canvas.querySelectorAll<HTMLElement>(".react-flow__node")) {
        if (other === node) later = true;
        else if (
          (Number(other.style.zIndex) || 0) > z ||
          ((Number(other.style.zIndex) || 0) === z && later)
        ) {
          covers.push(other);
        }
      }
    }
    return covers.map((cover) => cover.getBoundingClientRect());
  };
  const place = (view: HTMLElement): Record<string, string> | null => {
    const id = view.dataset.previewViewport;
    const slot = id
      ? document.querySelector(`[data-browser-surface-slot="${CSS.escape(id)}"]`)
      : null;
    if (view.style.zIndex === "-1" || !slot || !canvas.contains(slot)) return null;
    const fullScreen = fullScreenLayer.firstElementChild;
    const area = fullScreen ?? canvas;
    if (!area.contains(slot)) return { clipPath: "inset(50%)" };
    const rect = slot.getBoundingClientRect();
    const left = Math.round(rect.left);
    const top = Math.round(rect.top);
    const right = left + Math.max(1, Math.round(rect.width));
    const bottom = top + Math.max(1, Math.round(rect.height));
    const window = (slot.closest(".board-window") ?? slot).getBoundingClientRect();
    const visible = coveredBy(
      intersect(intersect({ left, top, right, bottom }, window), area.getBoundingClientRect()),
      fullScreen ? [] : coversOf(slot),
    ).map((part) => ({
      left: Math.round(part.left),
      top: Math.round(part.top),
      right: Math.round(part.right),
      bottom: Math.round(part.bottom),
    }));
    // In the view's own coordinates, as disjoint rectangles so overlapping covers stay covered.
    const parts = visible.map(
      (part) =>
        `M ${part.left - left} ${part.top - top} H ${part.right - left} V ${part.bottom - top} H ${part.left - left} Z`,
    );
    const only = visible.length === 1 ? visible[0] : undefined;
    const clipPath = only
      ? `inset(${only.top - top}px ${right - only.right}px ${bottom - only.bottom}px ${only.left - left}px)`
      : parts.length > 0
        ? `path("${parts.join(" ")}")`
        : "inset(50%)";
    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
      clipPath,
    };
  };
  const sync = () => {
    const current = document.querySelector("[data-electron-browser-host]");
    if (current !== host) {
      host = current;
      if (host) watch.observe(host, { subtree: true, childList: true, attributeFilter: ["style"] });
    }
    let resized = false;
    for (const view of views()) {
      const style = place(view);
      if (!style) {
        if (owned.delete(view)) view.style.clipPath = "";
        continue;
      }
      owned.add(view);
      const { width, height, ...placed } = style;
      // Upstream sizes the page's layout from its own reading of the slot, so it re-reads on a resize.
      if (width && (view.style.width !== width || view.style.height !== height)) resized = true;
      for (const [name, value] of Object.entries(placed)) {
        if (view.style.getPropertyValue(name === "clipPath" ? "clip-path" : name) !== value) {
          view.style.setProperty(name === "clipPath" ? "clip-path" : name, value);
        }
      }
    }
    // Our own writes need no second pass.
    watch.takeRecords();
    if (resized) document.dispatchEvent(new Event("scroll"));
  };
  const watch = new MutationObserver(sync);
  // The viewport's transform pans and zooms the board; a node's style moves, resizes or restacks
  // a window or agent; a floating panel's style moves it. With no page shown, only a move of a
  // window holding one matters.
  const moved = new MutationObserver((records) => {
    if (
      records.some(
        ({ target }) =>
          target instanceof Element &&
          (target.matches(".react-flow__viewport") ||
            (target.matches(".react-flow__node, .board-canvas > *") &&
              (owned.size > 0 || target.querySelector("[data-browser-surface-slot]") !== null))),
      )
    ) {
      sync();
    }
  });
  moved.observe(canvas, { subtree: true, attributeFilter: ["style"] });
  watch.observe(fullScreenLayer, { childList: true });
  // Panels opening over the board.
  watch.observe(canvas, { childList: true });
  // The desktop's views mount with the app, which can be after the board.
  watch.observe(document.body, { childList: true });
  window.addEventListener("resize", sync);
  sync();
  return () => {
    watch.disconnect();
    moved.disconnect();
    window.removeEventListener("resize", sync);
    for (const view of owned) view.style.clipPath = "";
    document.dispatchEvent(new Event("scroll"));
  };
}
