import { useState, type CSSProperties, type PointerEvent, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";

type PanelPosition = { readonly x: number; readonly y: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
function readPanelPosition(key: string): PanelPosition | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${key}-position`) ?? "null");
    return value && typeof value === "object" && "x" in value && "y" in value
      ? { x: Number(value.x), y: Number(value.y) }
      : null;
  } catch {
    return null;
  }
}
function savePanelPosition(key: string, position: PanelPosition) {
  try {
    localStorage.setItem(`${key}-position`, JSON.stringify(position));
  } catch {
    // Storage can be unavailable; the panel just opens at its default spot next time.
  }
}

let morphing = false;
const BLUR_MS = 280;
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const fade = (element: Element, to: number, duration: number) =>
  element.animate([{ opacity: Number(getComputedStyle(element).opacity) }, { opacity: to }], {
    duration,
    easing: "ease-out",
    fill: "forwards",
  }).finished;

/**
 * Toggles full screen through a blur of the board, with the new panel crossfading in sync with the
 * blur. Resizing re-lays out the whole chat and blocks the main thread, so it happens first, while
 * a still copy of the old panel stands in.
 */
export async function morphPanel(panel: HTMLElement | null, maximize: boolean, update: () => void) {
  if (morphing) return;
  if (!panel || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  morphing = true;
  const backdrop = document.createElement("div");
  backdrop.className = "board-panel-backdrop";
  backdrop.style.opacity = maximize ? "0" : "1";
  document.body.append(backdrop);
  // A still copy of the old panel covers the swap: opening leaves the small one under the blur, so
  // it blurs with the board while the full panel fades in; closing fades the full one out over the
  // small one as the blur clears.
  const still = snapshot(panel, maximize ? "14" : "60");
  try {
    panel.style.opacity = "0";
    flushSync(update);
    // The chat re-renders once more when it observes its new size; let that pass before fading in.
    await nextFrame();
    await nextFrame();
    if (maximize) await Promise.all([fade(panel, 1, BLUR_MS), fade(backdrop, 1, BLUR_MS)]);
    else {
      panel.style.opacity = "";
      await Promise.all([fade(still, 0, BLUR_MS), fade(backdrop, 0, BLUR_MS)]);
    }
  } finally {
    for (const animation of panel.getAnimations()) animation.cancel();
    panel.style.opacity = "";
    still.remove();
    backdrop.remove();
    morphing = false;
  }
}

function snapshot(panel: HTMLElement, zIndex: string) {
  const copy = panel.cloneNode(true) as HTMLElement;
  const rect = panel.getBoundingClientRect();
  Object.assign(copy.style, {
    position: "fixed",
    inset: "auto",
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    zIndex,
    pointerEvents: "none",
  });
  copy.inert = true;
  document.body.append(copy);
  // A clone starts scrolled to the top; match the chat's scroll positions.
  const from = panel.querySelectorAll("*");
  const to = copy.querySelectorAll("*");
  from.forEach((element, index) => {
    if (element.scrollTop || element.scrollLeft) {
      to[index]?.scrollTo(element.scrollLeft, element.scrollTop);
    }
  });
  return copy;
}

const MIN_PANEL = { w: 320, h: 260 };
type PanelSize = { readonly w: number; readonly h: number };
function readPanelSize(key: string): PanelSize | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${key}-size`) ?? "null");
    return value && typeof value === "object" && "w" in value && "h" in value
      ? { w: Number(value.w), h: Number(value.h) }
      : null;
  } catch {
    return null;
  }
}
function savePanelSize(key: string, size: PanelSize) {
  try {
    localStorage.setItem(`${key}-size`, JSON.stringify(size));
  } catch {
    // Storage can be unavailable; the panel just opens at its default size next time.
  }
}
type ResizeEdges = {
  readonly left?: boolean;
  readonly right?: boolean;
  readonly top?: boolean;
  readonly bottom?: boolean;
};
const RESIZE_HANDLES: ReadonlyArray<{ readonly edges: ResizeEdges; readonly className: string }> = [
  { edges: { left: true }, className: "inset-y-3 -left-1 w-2 cursor-ew-resize" },
  { edges: { right: true }, className: "inset-y-3 -right-1 w-2 cursor-ew-resize" },
  { edges: { bottom: true }, className: "inset-x-3 -bottom-1 h-2 cursor-ns-resize" },
  { edges: { top: true }, className: "inset-x-3 -top-1 h-2 cursor-ns-resize" },
  { edges: { left: true, top: true }, className: "-top-1 -left-1 size-4 cursor-nwse-resize" },
  { edges: { right: true, top: true }, className: "-top-1 -right-1 size-4 cursor-nesw-resize" },
  { edges: { left: true, bottom: true }, className: "-bottom-1 -left-1 size-4 cursor-nesw-resize" },
  {
    edges: { right: true, bottom: true },
    className: "-right-1 -bottom-1 size-4 cursor-nwse-resize",
  },
];

/**
 * A board-owned window over the canvas: drag it by its header's empty space, resize it from its
 * edges and corners. Its spot and size are kept per viewer under `storageKey`.
 */
export function FloatingPanel(props: {
  readonly storageKey: string;
  readonly label: string;
  /** Default placement and size, used until the viewer moves or resizes it. */
  readonly className: string;
  readonly header: ReactNode;
  readonly children: ReactNode;
  /** When this changes to a non-null value, the panel returns to its default place and size. */
  readonly resetKey?: string | null;
  /** Fills the whole window; toggle it through `morphPanel` to animate the change. */
  readonly maximized?: boolean;
  readonly ref?: Ref<HTMLElement>;
}) {
  const { storageKey, ref } = props;
  const [position, setPosition] = useState(() => readPanelPosition(storageKey));
  const [size, setSize] = useState(() => readPanelSize(storageKey));
  const [seenReset, setSeenReset] = useState(props.resetKey ?? null);
  if ((props.resetKey ?? null) !== seenReset) {
    setSeenReset(props.resetKey ?? null);
    if (props.resetKey) {
      setPosition(null);
      setSize(null);
    }
  }

  const full = props.maximized ?? false;

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
      if (next) savePanelPosition(storageKey, next);
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
      let y = start.top;
      if (edges.right) w = clamp(start.w + dx, MIN_PANEL.w, board.clientWidth - start.left);
      if (edges.left) {
        w = clamp(start.w - dx, MIN_PANEL.w, start.left + start.w);
        x = start.left + start.w - w;
      }
      if (edges.bottom) h = clamp(start.h + dy, MIN_PANEL.h, board.clientHeight - start.top);
      if (edges.top) {
        h = clamp(start.h - dy, MIN_PANEL.h, start.top + start.h);
        y = start.top + start.h - h;
      }
      nextSize = { w, h };
      nextPosition = { x, y };
      setSize(nextSize);
      setPosition(nextPosition);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      savePanelSize(storageKey, nextSize);
      savePanelPosition(storageKey, nextPosition);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const style: CSSProperties = full
    ? {}
    : {
        ...(position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : {}),
        ...(size ? { width: size.w, height: size.h, maxWidth: "none" } : {}),
      };

  return (
    <aside
      ref={ref}
      aria-label={props.label}
      data-full={full || undefined}
      className={`board-chat-panel flex flex-col border bg-background shadow-lg ${
        full ? "fixed inset-0 z-50 rounded-none" : `absolute z-20 rounded-xl ${props.className}`
      }`}
      style={style}
    >
      {full ? (
        <div
          aria-hidden
          className="h-(--native-titlebar-height) shrink-0"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        />
      ) : null}
      {full
        ? null
        : RESIZE_HANDLES.map((handle) => (
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
        {props.header}
      </div>
      {props.children}
    </aside>
  );
}
