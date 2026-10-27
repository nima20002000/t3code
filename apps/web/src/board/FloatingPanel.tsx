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

const floatingRects = new WeakMap<Element, DOMRect>();
let morphing = false;
const FADE_MS = 70;
const MOVE_MS = 220;
const REVEAL_MS = 110;
const BLUR_MS = 160;
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * Toggles full screen behind an empty panel frame that moves on the compositor (transform and
 * opacity only), so the chat re-laying out at its new size can block the main thread without a
 * dropped frame. The board blurs first and the frame fades in over the panel, then moves; the panel
 * crossfades back in as it lands, and only then does the blur clear.
 */
export async function morphPanel(panel: HTMLElement | null, maximize: boolean, update: () => void) {
  if (morphing) return;
  const window_ = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  if (maximize && panel) floatingRects.set(panel, panel.getBoundingClientRect());
  const target = maximize ? window_ : panel && floatingRects.get(panel);
  if (!panel || !target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  morphing = true;
  const { width: W, height: H } = window_;
  // The fill scales freely; each 1px edge scales along its length only, so the border stays crisp.
  const parts = {
    fill: (r: DOMRect) => `translate(${r.x}px, ${r.y}px) scale(${r.width / W}, ${r.height / H})`,
    top: (r: DOMRect) => `translate(${r.x}px, ${r.y}px) scale(${r.width / W}, 1)`,
    bottom: (r: DOMRect) => `translate(${r.x}px, ${r.bottom - 1}px) scale(${r.width / W}, 1)`,
    left: (r: DOMRect) => `translate(${r.x}px, ${r.y}px) scale(1, ${r.height / H})`,
    right: (r: DOMRect) => `translate(${r.right - 1}px, ${r.y}px) scale(1, ${r.height / H})`,
  };
  const card = document.createElement("div");
  card.className = "board-panel-morph";
  const from = panel.getBoundingClientRect();
  // Opening waits for the blur to settle before growing; closing starts shrinking at once.
  const lead = maximize ? BLUR_MS : FADE_MS;
  const moves = Object.entries(parts).map(([part, place]) => {
    const element = document.createElement("div");
    element.dataset.part = part;
    card.append(element);
    return element.animate([{ transform: place(from) }, { transform: place(target) }], {
      delay: lead,
      duration: MOVE_MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      fill: "both",
    });
  });
  const backdrop = document.createElement("div");
  backdrop.className = "board-panel-backdrop";
  document.body.append(backdrop, card);
  try {
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: maximize ? BLUR_MS : FADE_MS,
      fill: "forwards",
    });
    await card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, fill: "forwards" })
      .finished;
    // The frame now covers the panel, so it can vanish and change size unseen.
    const hide = panel.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: "forwards" });
    flushSync(update);
    await nextFrame();
    // At 90% of its time the eased move is within a few pixels of landing; reveal over the rest.
    const left = lead + MOVE_MS * 0.9 - Number(moves[0]?.currentTime ?? 0);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    // The panel shows whole under the frame, which shares its fill, so no board bleeds through.
    hide.cancel();
    await card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: REVEAL_MS, fill: "forwards" })
      .finished;
    if (!maximize) {
      await backdrop.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: BLUR_MS,
        fill: "forwards",
      }).finished;
    }
  } finally {
    card.remove();
    backdrop.remove();
    morphing = false;
  }
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
