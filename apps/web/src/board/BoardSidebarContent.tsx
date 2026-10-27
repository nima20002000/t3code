import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, MoreHorizontalIcon, PlusIcon, SettingsIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

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
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "./upstream";

type Dialog =
  | { readonly kind: "new-workspace" }
  | { readonly kind: "rename-workspace"; readonly id: string; readonly name: string }
  | { readonly kind: "delete-workspace"; readonly id: string; readonly name: string }
  | { readonly kind: "workspace-settings"; readonly id: string }
  | { readonly kind: "new-workflow"; readonly workspaceId: string }
  | { readonly kind: "rename-workflow"; readonly id: string; readonly name: string }
  | { readonly kind: "delete-workflow"; readonly id: string; readonly name: string };

/** Workspaces as groups with their workflows beneath; replaces the thread list on /board. */
export function BoardSidebarContent() {
  const { snapshot, currentId } = useBoardState();
  const workspaces = useBoardWorkspaces();
  const workflows = snapshot?.workflows ?? [];
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const navigate = useNavigate();
  const { open, setOpen } = useSidebar();
  const settingsWorkspace =
    dialog?.kind === "workspace-settings"
      ? workspaces.find((workspace) => workspace.id === dialog.id)
      : undefined;

  return (
    <>
      <SidebarHeader>
        {open ? (
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              <WorkflowIcon className="size-4" />
              Board
            </span>
            <IconButton label="New workspace" onClick={() => setDialog({ kind: "new-workspace" })}>
              <PlusIcon />
            </IconButton>
          </div>
        ) : (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Expand sidebar" onClick={() => setOpen(true)}>
                <WorkflowIcon />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarHeader>
      <SidebarContent>
        {workspaces.length === 0 ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">No workspaces yet.</p>
        ) : null}
        {workspaces.map((workspace) => (
          <SidebarGroup key={workspace.id}>
            <SidebarMenu>
              <SidebarMenuItem>
                {open ? null : (
                  <SidebarMenuButton tooltip={workspace.name} onClick={() => setOpen(true)}>
                    <FolderIcon />
                  </SidebarMenuButton>
                )}
                <div className="flex items-center gap-1 group-data-[collapsible=icon]:hidden">
                  <SidebarMenuButton className="flex-1" render={<div />}>
                    <FolderIcon />
                    <span className="truncate">{workspace.name}</span>
                  </SidebarMenuButton>
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
                </div>
              </SidebarMenuItem>
              <SidebarMenuSub>
                {workflows
                  .filter((workflow) => workflow.workspaceId === workspace.id)
                  .map((workflow) => (
                    <SidebarMenuSubItem key={workflow.id}>
                      <div className="flex items-center gap-1">
                        <SidebarMenuSubButton
                          className="flex-1"
                          isActive={workflow.id === currentId}
                          render={<button type="button" />}
                          onClick={() => setCurrentWorkflow(workflow.id)}
                        >
                          <span>{workflow.name}</span>
                        </SidebarMenuSubButton>
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
                      </div>
                    </SidebarMenuSubItem>
                  ))}
              </SidebarMenuSub>
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings"
              onClick={() => void navigate({ to: "/settings" })}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
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
    </>
  );
}
