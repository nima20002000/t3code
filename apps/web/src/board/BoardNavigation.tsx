import { useLocation, useNavigate } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { memo, useRef, type ComponentProps, type PointerEvent } from "react";
import * as Schema from "effect/Schema";
import { BoardSidebarContent } from "./BoardSidebarContent";
import {
  Sidebar,
  SidebarMenu,
  SidebarRail,
  setLocalStorageItem,
  SidebarMenuButton,
  SidebarMenuItem,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  useSidebar,
} from "./upstream";

export function boardHidesSidebar(pathname: string) {
  return pathname === "/board";
}

type SidebarResizable = Exclude<ComponentProps<typeof Sidebar>["resizable"], boolean | undefined>;

const ICON_WIDTH = 48;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/**
 * Foreman-style edge: the board sidebar follows the pointer down to its icon rail, then settles on
 * release (folded below the halfway point, else at least its minimum width) with t3's panel timing.
 */
function BoardSidebarRail(props: { readonly options: SidebarResizable }) {
  const { options } = props;
  const { open, setOpen } = useSidebar();
  const dragged = useRef(false);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rail = event.currentTarget;
    const root = rail.closest<HTMLElement>("[data-slot='sidebar']");
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const container = root?.querySelector<HTMLElement>("[data-slot='sidebar-container']");
    const gap = root?.querySelector<HTMLElement>("[data-slot='sidebar-gap']");
    if (!wrapper || !container || !gap) return;
    const targets = [gap, container];
    const min = options.minWidth ?? ICON_WIDTH;
    const max = options.maxWidth ?? Number.POSITIVE_INFINITY;
    const startX = event.clientX;
    const startWidth = container.getBoundingClientRect().width;
    let width = startWidth;
    dragged.current = false;
    rail.setPointerCapture(event.pointerId);
    const setWidth = (value: number) => {
      for (const target of targets) target.style.width = `${value}px`;
    };
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (!dragged.current) {
        if (Math.abs(moveEvent.clientX - startX) < 3) return;
        dragged.current = true;
        for (const target of targets) target.style.transitionDuration = "0ms";
        setWidth(startWidth);
        if (!open) setOpen(true);
      }
      width = clamp(startWidth + moveEvent.clientX - startX, ICON_WIDTH, max);
      setWidth(width);
    };
    const end = () => {
      rail.removeEventListener("pointermove", move);
      rail.removeEventListener("pointerup", end);
      rail.removeEventListener("pointercancel", end);
      if (!dragged.current) return;
      const fold = width < (min + ICON_WIDTH) / 2;
      const settled = fold ? ICON_WIDTH : Math.max(width, min);
      for (const target of targets) target.style.removeProperty("transition-duration");
      // Read layout so the settle below transitions from the dragged width.
      void container.offsetWidth;
      setWidth(settled);
      if (fold) setOpen(false);
      else {
        wrapper.style.setProperty("--sidebar-width", `${settled}px`);
        if (options.storageKey) {
          try {
            setLocalStorageItem(options.storageKey, settled, Schema.Finite);
          } catch (error) {
            console.error("Could not persist sidebar width.", error);
          }
        }
        options.onResize?.(settled);
      }
      const settleMs = Number.parseFloat(getComputedStyle(container).transitionDuration) * 1000;
      window.setTimeout(() => {
        for (const target of targets) target.style.removeProperty("width");
      }, settleMs + 50);
    };
    rail.addEventListener("pointermove", move);
    rail.addEventListener("pointerup", end);
    rail.addEventListener("pointercancel", end);
  };

  return (
    <SidebarRail
      onPointerDown={onPointerDown}
      onClick={(event) => {
        event.preventDefault();
        if (dragged.current) dragged.current = false;
        else if (!open) setOpen(true);
      }}
    />
  );
}

export function BoardSidebar(props: ComponentProps<typeof Sidebar>) {
  const onBoard = useLocation({ select: (location) => boardHidesSidebar(location.pathname) });
  const { resizable } = props;
  return onBoard ? (
    <Sidebar {...props} collapsible="icon" aria-label="Board">
      <BoardSidebarContent />
      {typeof resizable === "object" ? <BoardSidebarRail options={resizable} /> : null}
    </Sidebar>
  ) : (
    <Sidebar {...props} />
  );
}

function useOpenBoard() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/board" });
  };
}

export const SidebarBoardLink = memo(function SidebarBoardLink() {
  const openBoard = useOpenBoard();
  const active = useLocation({ select: (location) => location.pathname === "/board" });
  return (
    <SidebarMenu className="mt-1">
      <SidebarMenuItem>
        <SidebarMenuButton isActive={active} onClick={openBoard}>
          <WorkflowIcon />
          <span>Board</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
});

export function SidebarBoardUtility() {
  const openBoard = useOpenBoard();
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label="Board" onClick={openBoard} size="icon">
              <WorkflowIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Board</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
