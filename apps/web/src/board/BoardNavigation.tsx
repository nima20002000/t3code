import { useLocation, useNavigate } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { memo, type ComponentProps } from "react";
import { BoardSidebarContent } from "./BoardSidebarContent";
import {
  Sidebar,
  SidebarMenu,
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

export function BoardSidebar(props: ComponentProps<typeof Sidebar>) {
  const onBoard = useLocation({ select: (location) => boardHidesSidebar(location.pathname) });
  const { setOpen } = useSidebar();
  const { resizable } = props;
  // Dragging the edge all the way left folds the board sidebar to its icon rail, as in Foreman.
  const folding: SidebarResizable | undefined =
    typeof resizable === "object"
      ? {
          ...resizable,
          shouldAcceptWidth: (input) => {
            if (input.nextWidth <= (resizable.minWidth ?? 0)) {
              setOpen(false);
              return false;
            }
            return resizable.shouldAcceptWidth?.(input) ?? true;
          },
        }
      : undefined;
  return onBoard ? (
    <Sidebar
      {...props}
      collapsible="icon"
      {...(folding ? { resizable: folding } : {})}
      aria-label="Board"
    >
      <BoardSidebarContent />
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
