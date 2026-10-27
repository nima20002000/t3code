import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  CloudOffIcon,
  KanbanIcon,
  LinkIcon,
  Loader2Icon,
  PlusIcon,
  Redo2Icon,
  RotateCcwIcon,
  Undo2Icon,
} from "lucide-react";
import { useState } from "react";

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
import { BrowsersButton } from "./toolbar/BrowsersButton";
import { FilesButton } from "./toolbar/FilesButton";
import { IconButton } from "./toolbar/IconButton";
import { MachinesButton } from "./toolbar/MachinesButton";
import { RunsSelector } from "./toolbar/RunsSelector";
import { ScheduleButton } from "./toolbar/ScheduleButton";
import { WorkflowMenu } from "./toolbar/WorkflowMenu";
import { WorkflowName } from "./toolbar/WorkflowName";
import { WorkflowSettings } from "./toolbar/WorkflowSettings";
import { Button, Tooltip, TooltipPopup, TooltipTrigger } from "./upstream";

const COLLAPSED_KEY = "board:controls-collapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function BackButton() {
  const router = useRouter();
  const navigate = useNavigate();
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        if (router.state.location.state.__TSR_index > 0) router.history.back();
        else void navigate({ to: "/" });
      }}
    >
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
  readonly selectedRunId: string | null;
  readonly onSelectRun: (runId: string | null) => void;
  readonly kanban: boolean;
  readonly onToggleKanban: () => void;
  readonly onAddAgent: () => void;
  readonly onAddThread: () => void;
}) {
  const workflow = useCurrentWorkflow();
  const { status, error } = useBoardState();
  const pending = useBoardPending();
  const { canUndo, canRedo, dirty } = useBoardHistory();

  const savedLabel =
    status !== "connected"
      ? "Offline"
      : pending
        ? "Saving"
        : "Saved: the board saves automatically";
  const SavedIcon = status !== "connected" ? CloudOffIcon : pending ? Loader2Icon : CheckIcon;
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

  if (collapsed) {
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <div
          className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-lg"
          role="toolbar"
          aria-label="Board controls"
        >
          <RunControl />
          {collapseButton}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      <div
        className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-lg"
        role="toolbar"
        aria-label="Draft actions"
      >
        <IconButton
          label="Undo"
          disabled={!canUndo || pending || status !== "connected"}
          onClick={undo}
        >
          <Undo2Icon />
        </IconButton>
        <IconButton
          label="Redo"
          disabled={!canRedo || pending || status !== "connected"}
          onClick={redo}
        >
          <Redo2Icon />
        </IconButton>
        <IconButton
          label="Discard changes"
          disabled={!dirty || pending || status !== "connected"}
          onClick={discardChanges}
        >
          <RotateCcwIcon />
        </IconButton>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="inline-flex items-center gap-1 px-1.5 text-2xs text-muted-foreground [&>svg]:size-3"
                role="status"
                aria-label={savedLabel}
              >
                <SavedIcon aria-hidden="true" />
              </span>
            }
          />
          <TooltipPopup>{error ?? savedLabel}</TooltipPopup>
        </Tooltip>
      </div>
      <div
        className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-lg"
        role="toolbar"
        aria-label="Board controls"
      >
        <RunsSelector
          runs={workflow.runs}
          selectedRunId={props.selectedRunId}
          onSelect={props.onSelectRun}
        />
      </div>
      <div
        className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-lg"
        role="toolbar"
        aria-label="Workflow controls"
      >
        <WorkflowMenu onRename={() => window.setTimeout(props.onRename, 150)} />
        <IconButton label="Add agent" onClick={props.onAddAgent}>
          <PlusIcon />
        </IconButton>
        <IconButton label="Add existing thread" onClick={props.onAddThread}>
          <LinkIcon />
        </IconButton>
        <WorkflowSettings />
        <MachinesButton />
        {/* t3-backed buttons: approvals, files, browsers, schedule */}
        <ApprovalsButton nodes={workflow.nodes} />
        <FilesButton nodes={workflow.nodes} />
        <BrowsersButton nodes={workflow.nodes} />
        <ScheduleButton nodes={workflow.nodes} />
        <ActivitiesButton log={workflow.log} />
        <IconButton
          label="Kanban"
          variant={props.kanban ? "secondary" : "ghost"}
          aria-pressed={props.kanban}
          onClick={props.onToggleKanban}
        >
          <KanbanIcon />
        </IconButton>
        <RunControl />
        {collapseButton}
      </div>
    </div>
  );
}
