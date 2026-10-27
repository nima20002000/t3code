import { useLocation, useNavigate } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { memo, type ComponentProps } from "react";
import { BoardSidebarPanel } from "./BoardSidebarContent";
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

// Settings opened from the board keep the board's sidebar behind them instead of t3's thread list.
let settingsFromBoard = false;
export function markSettingsFromBoard() {
  settingsFromBoard = true;
}

export function boardHidesSidebar(pathname: string) {
  if (pathname === "/board") return true;
  if (pathname.startsWith("/settings")) return settingsFromBoard;
  settingsFromBoard = false;
  return false;
}

export function BoardSidebar(props: ComponentProps<typeof Sidebar>) {
  const onBoard = useLocation({ select: (location) => boardHidesSidebar(location.pathname) });
  return onBoard ? <BoardSidebarPanel /> : <Sidebar {...props} />;
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
