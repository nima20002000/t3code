import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ClipboardListIcon,
  CloudOffIcon,
  BotIcon,
  Redo2Icon,
  RotateCcwIcon,
  Undo2Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  discardChanges,
  redo,
  renameWorkflow,
  undo,
  useBoardHistory,
  useCurrentWorkflow,
  useBoardState,
} from "./boardStore";
import { useBoardPending } from "./boardApi";
import { RunControl } from "./RunControl";
import { ActivitiesButton } from "./toolbar/ActivitiesButton";
import { ApprovalsButton } from "./toolbar/ApprovalsButton";
import { FilesButton } from "./toolbar/FilesButton";
import { IconButton } from "./toolbar/IconButton";
import { MachinesButton } from "./toolbar/MachinesButton";
import { ScheduleButton } from "./toolbar/ScheduleButton";
import { WorkflowMenu } from "./toolbar/WorkflowMenu";
import { WorkflowName } from "./toolbar/WorkflowName";
import { Button, Tooltip, TooltipPopup, TooltipTrigger } from "./upstream";

const COLLAPSED_KEY = "board:controls-collapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Folds its children sideways to nothing; inert while folded so hidden controls take no focus. */
function Collapsible(props: {
  readonly collapsed: boolean;
  readonly spaced?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={`grid transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none ${
        props.collapsed ? "grid-cols-[0fr] opacity-0" : "grid-cols-[1fr] opacity-100"
      }`}
      inert={props.collapsed}
    >
      <div
        className={`-my-3 min-w-0 overflow-hidden py-3 ${!props.collapsed && props.spaced ? "pr-2" : ""}`}
      >
        {props.children}
      </div>
    </div>
  );
}

function BackButton() {
  const navigate = useNavigate();
  return (
    <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/" })}>
      <ArrowLeftIcon />
      Back
    </Button>
  );
}

/** Back and the workflow name; lives in the window header. */
export function BoardTitle(props: {
  readonly editing: boolean;
  readonly onEditingChange: (editing: boolean) => void;
}) {
  const workflow = useCurrentWorkflow();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <BackButton />
      <div className="flex min-w-0 flex-col items-start">
        <WorkflowName
          key={workflow.name}
          editing={props.editing}
          onEditingChange={props.onEditingChange}
          name={workflow.name}
          onRename={(next) => renameWorkflow(workflow.id, next)}
        />
      </div>
    </div>
  );
}

/** Foreman-style clusters of board controls, floating at the board's top right. */
export function BoardToolbar(props: {
  readonly onRename: () => void;
  readonly onSelectRun: (runId: string | null) => void;
  readonly kanbanOnBoard: boolean;
  readonly onKanban: () => void;
  readonly onAddAgent: () => void;
}) {
  const workflow = useCurrentWorkflow();
  const { status, error } = useBoardState();
  const pending = useBoardPending();
  const { canUndo, canRedo, restorable } = useBoardHistory();
  const editable = !pending && status === "connected";
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {}
  };
  const collapseButton = (
    <IconButton
      label={collapsed ? "Expand controls" : "Collapse controls"}
      onClick={toggleCollapsed}
    >
      {collapsed ? <ChevronsLeftIcon /> : <ChevronsRightIcon />}
    </IconButton>
  );

  return (
    <div className="flex flex-wrap justify-end">
      <Collapsible collapsed={collapsed} spaced>
        <div
          className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-lg"
          role="toolbar"
          aria-label="Draft actions"
        >
          <IconButton label="Undo (Ctrl+Z)" disabled={!canUndo || !editable} onClick={undo}>
            <Undo2Icon />
          </IconButton>
          <IconButton label="Redo (Ctrl+Y)" disabled={!canRedo || !editable} onClick={redo}>
            <Redo2Icon />
          </IconButton>
          <IconButton
            label="Restore the board as it was when opened"
            disabled={!restorable || !editable}
            onClick={discardChanges}
          >
            <RotateCcwIcon />
          </IconButton>
          {status === "connected" ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="inline-flex items-center gap-1 px-1.5 text-2xs text-muted-foreground [&>svg]:size-3"
                    role="status"
                    aria-label="Offline"
                  >
                    <CloudOffIcon aria-hidden="true" />
                  </span>
                }
              />
              <TooltipPopup>{error ?? "Offline"}</TooltipPopup>
            </Tooltip>
          )}
        </div>
      </Collapsible>
      <div
        className="flex max-w-full flex-wrap items-center justify-end rounded-lg border border-border bg-card p-1 shadow-lg"
        role="toolbar"
        aria-label="Workflow controls"
      >
        <Collapsible collapsed={collapsed}>
          <div className="flex flex-wrap items-center justify-end gap-0.5 pr-0.5">
            <WorkflowMenu onRename={() => window.setTimeout(props.onRename, 150)} />
            <IconButton label="Add agent" onClick={props.onAddAgent}>
              <BotIcon />
            </IconButton>
            <MachinesButton />
            {/* t3-backed buttons: approvals, files, schedule */}
            <ApprovalsButton nodes={workflow.nodes} />
            <FilesButton workspaceId={workflow.workspaceId} />
            <ScheduleButton nodes={workflow.nodes} />
            <ActivitiesButton
              log={workflow.log}
              runs={workflow.runs}
              onShowRun={props.onSelectRun}
            />
            <IconButton
              label={props.kanbanOnBoard ? "Show kanban" : "Add kanban"}
              onClick={props.onKanban}
            >
              <ClipboardListIcon />
            </IconButton>
          </div>
        </Collapsible>
        <div className="flex items-center gap-0.5">
          <RunControl />
          {collapseButton}
        </div>
      </div>
    </div>
  );
}
