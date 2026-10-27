import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, MoreHorizontalIcon, PlusIcon, SettingsIcon, WorkflowIcon } from "lucide-react";
import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";

import {
  createWorkflowIn,
  createWorkspace,
  removeWorkflow,
  removeWorkspace,
  renameWorkflow,
  renameWorkspace,
  setCurrentWorkflow,
  useBoardState,
  useBoardWorkspaces,
} from "./boardStore";
import { ConfirmDialog, NameDialog, WorkspaceSettingsDialog } from "./WorkspaceDialogs";
import { IconButton } from "./toolbar/IconButton";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./upstream";

type Dialog =
  | { readonly kind: "new-workspace" }
  | { readonly kind: "rename-workspace"; readonly id: string; readonly name: string }
  | { readonly kind: "delete-workspace"; readonly id: string; readonly name: string }
  | { readonly kind: "workspace-settings"; readonly id: string }
  | { readonly kind: "new-workflow"; readonly workspaceId: string }
  | { readonly kind: "rename-workflow"; readonly id: string; readonly name: string }
  | { readonly kind: "delete-workflow"; readonly id: string; readonly name: string };

const FOLDED = 48;
const MIN_OPEN = 180;
const DEFAULT_OPEN = 220;
const MAX_OPEN = 320;
const WIDTH_KEY = "board:sidebar-width";
const OPEN_WIDTH_KEY = "board:sidebar-open-width";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
/** Labels fade out over the last stretch before the icon rail, so text never just gets cut. */
const fadeFor = (width: number) => clamp((width - FOLDED - 16) / 96, 0, 1);

function readWidth(key: string, fallback: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= FOLDED ? clamp(value, FOLDED, MAX_OPEN) : fallback;
  } catch {
    return fallback;
  }
}
function saveWidth(key: string, width: number) {
  try {
    localStorage.setItem(key, String(width));
  } catch {
    // Storage can be unavailable; the sidebar just opens at its default width next time.
  }
}

function Row(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly active?: boolean;
  readonly indent?: boolean;
  readonly onClick: () => void;
  readonly actions?: ReactNode;
}) {
  return (
    <div
      className={`group/row flex h-8 items-center rounded-md ${props.indent ? "ml-[calc(var(--board-fade)*1rem)]" : ""} ${props.active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
    >
      <button
        type="button"
        aria-label={props.label}
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm"
        onClick={props.onClick}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">{props.icon}</span>
        <span className="truncate opacity-(--board-fade)">{props.label}</span>
      </button>
      {props.actions ? (
        <div className="flex shrink-0 items-center opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 @max-[11rem]:hidden">
          {props.actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The board's own sidebar (t3's thread sidebar is replaced on /board): workspaces with their
 * workflows. Its edge follows the pointer down to an icon rail; labels fade with the width.
 */
export function BoardSidebarPanel() {
  const { snapshot, currentId } = useBoardState();
  const workspaces = useBoardWorkspaces();
  const workflows = snapshot?.workflows ?? [];
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const navigate = useNavigate();
  const [width, setWidth] = useState(() => readWidth(WIDTH_KEY, DEFAULT_OPEN));
  const [dragging, setDragging] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const moved = useRef(false);
  const folded = width <= FOLDED;
  const settingsWorkspace =
    dialog?.kind === "workspace-settings"
      ? workspaces.find((workspace) => workspace.id === dialog.id)
      : undefined;

  const settle = (next: number) => {
    setWidth(next);
    saveWidth(WIDTH_KEY, next);
    if (next > FOLDED) saveWidth(OPEN_WIDTH_KEY, next);
  };
  const unfold = () => settle(readWidth(OPEN_WIDTH_KEY, DEFAULT_OPEN));

  // During a drag the width is written straight to the element; React only hears the final width.
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    const element = panel.current;
    if (event.button !== 0 || !element) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = element.getBoundingClientRect().width;
    let current = startWidth;
    moved.current = false;
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (!moved.current) {
        if (Math.abs(moveEvent.clientX - startX) < 3) return;
        moved.current = true;
        setDragging(true);
      }
      current = clamp(startWidth + moveEvent.clientX - startX, FOLDED, MAX_OPEN);
      element.style.width = `${current}px`;
      element.style.setProperty("--board-fade", String(fadeFor(current)));
      element.dataset.folded = String(current <= FOLDED + 8);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (!moved.current) return;
      const next = current < (MIN_OPEN + FOLDED) / 2 ? FOLDED : Math.max(current, MIN_OPEN);
      // Write the settled values too: React skips the style update when the width state is unchanged.
      element.style.width = `${next}px`;
      element.style.setProperty("--board-fade", String(fadeFor(next)));
      element.dataset.folded = String(next <= FOLDED);
      setDragging(false);
      settle(next);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <aside
      ref={panel}
      aria-label="Board"
      data-folded={folded}
      className={`@container relative hidden h-dvh shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex ${dragging ? "" : "transition-[width] duration-200 ease-out"}`}
      style={{ width, "--board-fade": fadeFor(width) } as CSSProperties}
    >
      <div className="drag-region flex h-12 shrink-0 items-center gap-1 px-2">
        <Row
          icon={<WorkflowIcon className="size-4" />}
          label="Board"
          onClick={() => (folded ? unfold() : undefined)}
          actions={
            <IconButton label="New workspace" onClick={() => setDialog({ kind: "new-workspace" })}>
              <PlusIcon />
            </IconButton>
          }
        />
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto px-2">
        {workspaces.length === 0 ? (
          <Row
            icon={<PlusIcon className="size-4" />}
            label="New workspace"
            onClick={() => (folded ? unfold() : setDialog({ kind: "new-workspace" }))}
          />
        ) : null}
        {workspaces.map((workspace) => (
          <div key={workspace.id} className="flex flex-col gap-0.5">
            <Row
              icon={<FolderIcon className="size-4" />}
              label={workspace.name}
              onClick={() => (folded ? unfold() : undefined)}
              actions={
                <>
                  <IconButton
                    label={`New workflow in ${workspace.name}`}
                    onClick={() => setDialog({ kind: "new-workflow", workspaceId: workspace.id })}
                  >
                    <PlusIcon />
                  </IconButton>
                  <Menu>
                    <MenuTrigger render={<IconButton label={`${workspace.name} actions`} />}>
                      <MoreHorizontalIcon />
                    </MenuTrigger>
                    <MenuPopup align="end" className="min-w-44">
                      <MenuItem
                        onClick={() => setDialog({ kind: "workspace-settings", id: workspace.id })}
                      >
                        Settings
                      </MenuItem>
                      <MenuItem
                        onClick={() =>
                          setDialog({
                            kind: "rename-workspace",
                            id: workspace.id,
                            name: workspace.name,
                          })
                        }
                      >
                        Rename
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        onClick={() =>
                          setDialog({
                            kind: "delete-workspace",
                            id: workspace.id,
                            name: workspace.name,
                          })
                        }
                      >
                        Delete
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </>
              }
            />
            <div className="flex flex-col gap-0.5 [[data-folded=true]_&]:hidden">
              {workflows.some((workflow) => workflow.workspaceId === workspace.id) ? null : (
                <Row
                  indent
                  icon={<PlusIcon className="size-3.5" />}
                  label="New workflow"
                  onClick={() => setDialog({ kind: "new-workflow", workspaceId: workspace.id })}
                />
              )}
              {workflows
                .filter((workflow) => workflow.workspaceId === workspace.id)
                .map((workflow) => (
                  <Row
                    key={workflow.id}
                    indent
                    icon={<span className="size-1.5 rounded-full bg-current opacity-60" />}
                    label={workflow.name}
                    active={workflow.id === currentId}
                    onClick={() => setCurrentWorkflow(workflow.id)}
                    actions={
                      <Menu>
                        <MenuTrigger render={<IconButton label={`${workflow.name} actions`} />}>
                          <MoreHorizontalIcon />
                        </MenuTrigger>
                        <MenuPopup align="end" className="min-w-36">
                          <MenuItem
                            onClick={() =>
                              setDialog({
                                kind: "rename-workflow",
                                id: workflow.id,
                                name: workflow.name,
                              })
                            }
                          >
                            Rename
                          </MenuItem>
                          <MenuItem
                            variant="destructive"
                            onClick={() =>
                              setDialog({
                                kind: "delete-workflow",
                                id: workflow.id,
                                name: workflow.name,
                              })
                            }
                          >
                            Delete
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    }
                  />
                ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="shrink-0 p-2">
        <Row
          icon={<SettingsIcon className="size-4" />}
          label="Settings"
          onClick={() => void navigate({ to: "/settings" })}
        />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize board sidebar"
        className="absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 hover:after:bg-border"
        onPointerDown={startDrag}
        onClick={() => {
          if (!moved.current && folded) unfold();
        }}
      />
      {dialog?.kind === "new-workspace" ? (
        <NameDialog
          title="New workspace"
          label="Workspace name"
          initial=""
          action="Create"
          onSubmit={createWorkspace}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "rename-workspace" ? (
        <NameDialog
          title="Rename workspace"
          label="Workspace name"
          initial={dialog.name}
          action="Rename"
          onSubmit={(name) => renameWorkspace(dialog.id, name)}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "new-workflow" ? (
        <NameDialog
          title="New workflow"
          label="Workflow name"
          initial="Workflow"
          action="Create"
          onSubmit={(name) => createWorkflowIn(dialog.workspaceId, name)}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "rename-workflow" ? (
        <NameDialog
          title="Rename workflow"
          label="Workflow name"
          initial={dialog.name}
          action="Rename"
          onSubmit={(name) => renameWorkflow(dialog.id, name)}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "delete-workspace" ? (
        <ConfirmDialog
          title={`Delete workspace "${dialog.name}"?`}
          description="Its workflows and runs are deleted. The workspace's folders on this PC are removed from disk; folders on VPS machines are kept."
          action="Delete workspace"
          onConfirm={() => removeWorkspace(dialog.id)}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "delete-workflow" ? (
        <ConfirmDialog
          title={`Delete workflow "${dialog.name}"?`}
          description="Its agents' threads are kept."
          action="Delete workflow"
          onConfirm={() => removeWorkflow(dialog.id)}
          onClose={close}
        />
      ) : null}
      {settingsWorkspace ? (
        <WorkspaceSettingsDialog workspace={settingsWorkspace} onClose={close} />
      ) : null}
    </aside>
  );
}
