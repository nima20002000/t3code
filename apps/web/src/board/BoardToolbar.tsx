import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  KanbanIcon,
  LinkIcon,
  PlusIcon,
  Redo2Icon,
  RotateCcwIcon,
  Undo2Icon,
} from "lucide-react";
import type { RefObject } from "react";

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
import { WorkflowName, type WorkflowNameHandle } from "./toolbar/WorkflowName";
import { WorkflowSettings } from "./toolbar/WorkflowSettings";
import "./toolbar/boardToolbar.css";
import { Button } from "./upstream";

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
export function BoardTitle(props: { readonly nameRef: RefObject<WorkflowNameHandle | null> }) {
  const workflow = useCurrentWorkflow();
  return (
    <div className="board-topbar-start">
      <BackButton />
      <div className="board-title">
        <WorkflowName
          ref={props.nameRef}
          name={workflow.name}
          onRename={(next) => renameWorkflow(workflow.id, next)}
        />
      </div>
    </div>
  );
}

/** Foreman-style clusters of board controls, floating at the board's top right. */
export function BoardToolbar(props: {
  readonly nameRef: RefObject<WorkflowNameHandle | null>;
  readonly selectedRunId: string | null;
  readonly onSelectRun: (runId: string | null) => void;
  readonly kanban: boolean;
  readonly onToggleKanban: () => void;
  readonly onAddAgent: () => void;
  readonly onAddThread: () => void;
  readonly selectedEdgeCount: number;
  readonly onDeleteSelectedEdges: () => void;
}) {
  const workflow = useCurrentWorkflow();
  const { status, error } = useBoardState();
  const pending = useBoardPending();
  const { canUndo, canRedo, dirty } = useBoardHistory();

  return (
    <div className="board-control-cluster">
      <div className="board-bar" role="toolbar" aria-label="Draft actions">
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
        <span className="board-saved" title={error ?? "The board saves automatically"}>
          <CheckIcon aria-hidden="true" />
          {status !== "connected" ? "Offline" : pending ? "Saving…" : "Saved"}
        </span>
      </div>
      <div className="board-bar" role="toolbar" aria-label="Board controls">
        <RunsSelector
          runs={workflow.runs}
          selectedRunId={props.selectedRunId}
          onSelect={props.onSelectRun}
        />
      </div>
      <div className="board-bar" role="toolbar" aria-label="Workflow controls">
        <WorkflowMenu
          onRename={() => window.setTimeout(() => props.nameRef.current?.begin(), 150)}
        />
        <Button size="sm" variant="ghost" onClick={props.onAddAgent}>
          <PlusIcon />
          Add agent
        </Button>
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
          className="board-kanban-toggle"
          aria-pressed={props.kanban}
          onClick={props.onToggleKanban}
        >
          <KanbanIcon />
        </IconButton>
        {props.selectedEdgeCount > 0 ? (
          <Button size="sm" variant="ghost" onClick={props.onDeleteSelectedEdges}>
            Delete selected edge
          </Button>
        ) : null}
        <RunControl />
      </div>
    </div>
  );
}
