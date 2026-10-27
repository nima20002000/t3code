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
import { useRef } from "react";

import { Button } from "../components/ui/button";
import {
  discardChanges,
  redo,
  renameWorkflow,
  undo,
  useBoardHistory,
  useCurrentWorkflow,
} from "./boardStore";
import { RunControl } from "./RunControl";
import { ActivitiesButton } from "./toolbar/ActivitiesButton";
import { IconButton } from "./toolbar/IconButton";
import { RunsSelector } from "./toolbar/RunsSelector";
import { WorkflowMenu } from "./toolbar/WorkflowMenu";
import { WorkflowName, type WorkflowNameHandle } from "./toolbar/WorkflowName";
import { WorkflowSettings } from "./toolbar/WorkflowSettings";
import "./toolbar/boardToolbar.css";

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

/**
 * Foreman-style board toolbar: Back and the workflow name on the left, then clusters of icon
 * buttons (draft actions, runs, workflow controls) on the right.
 */
export function BoardToolbar(props: {
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
  const { canUndo, canRedo, dirty } = useBoardHistory();
  const name = useRef<WorkflowNameHandle>(null);

  return (
    <div className="board-topbar" style={{ left: "max(1.25rem, var(--workspace-controls-left))" }}>
      <div className="board-topbar-start">
        <BackButton />
        <div className="board-title">
          <WorkflowName
            ref={name}
            name={workflow.name}
            onRename={(next) => renameWorkflow(workflow.id, next)}
          />
        </div>
      </div>
      <div className="board-control-cluster">
        <div className="board-bar" role="toolbar" aria-label="Draft actions">
          <IconButton label="Undo" disabled={!canUndo} onClick={undo}>
            <Undo2Icon />
          </IconButton>
          <IconButton label="Redo" disabled={!canRedo} onClick={redo}>
            <Redo2Icon />
          </IconButton>
          <IconButton label="Discard changes" disabled={!dirty} onClick={discardChanges}>
            <RotateCcwIcon />
          </IconButton>
          <span className="board-saved" title="The board saves automatically">
            <CheckIcon aria-hidden="true" />
            Saved
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
          <WorkflowMenu onRename={() => window.setTimeout(() => name.current?.begin(), 150)} />
          <Button size="sm" variant="ghost" onClick={props.onAddAgent}>
            <PlusIcon />
            Add agent
          </Button>
          <IconButton label="Add existing thread" onClick={props.onAddThread}>
            <LinkIcon />
          </IconButton>
          <WorkflowSettings />
          {/* t3-backed buttons: approvals, files, browsers, schedule */}
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
    </div>
  );
}
