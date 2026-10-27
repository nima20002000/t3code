import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type EnvironmentId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { ClockIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import type { BoardNode } from "../boardStore";
import { buildStartMessage } from "@t3tools/board-core/resultProtocol";
import { ToolbarPopover, useMachineLabel } from "./ToolbarPopover";

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";

function formatInterval(everyMs: number): string {
  const minutes = Math.round(everyMs / 60_000);
  return minutes % 60 === 0 ? `every ${minutes / 60} h` : `every ${minutes} min`;
}

/** Board schedules of one machine: t3 scheduled tasks that post into one of the board's threads. */
function EnvironmentSchedules(props: {
  readonly environmentId: EnvironmentId;
  readonly nodes: ReadonlyArray<BoardNode>;
  readonly onError: (message: string) => void;
}) {
  const { environmentId } = props;
  const machineLabel = useMachineLabel();
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const tasks: ReadonlyArray<ScheduledTask> = (query.data?.tasks ?? []).filter(
    (task) =>
      task.schedule.type === "interval" &&
      props.nodes.some((node) => node.threadId === task.threadId),
  );

  const onDelete = async (task: ScheduledTask) => {
    const result = await remove({ environmentId, input: { id: task.id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      props.onError(String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <>
      {tasks.map((task) => (
        <div key={task.id} className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate">{task.title}</div>
            <div className="truncate text-xs text-muted-foreground">
              {task.schedule.type === "interval" ? formatInterval(task.schedule.everyMs) : ""}
              {" · "}
              {machineLabel(environmentId)}
            </div>
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Delete schedule ${task.title}`}
            onClick={() => void onDelete(task)}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
    </>
  );
}

/**
 * Schedule this workflow: creates a t3 scheduled task (interval) bound to the entry node's thread,
 * so the server posts the run-start message into that thread. This bypasses the board's run
 * tracking (the board only sees the thread's replies). Listing and deleting use the same
 * scheduled-task queries and commands as the scheduled-tasks settings page.
 */
export function ScheduleButton(props: { readonly nodes: ReadonlyArray<BoardNode> }) {
  const shells = useQuietThreadShells();
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const [nodeId, setNodeId] = useState("");
  const [task, setTask] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = props.nodes.find((node) => node.id === nodeId) ?? props.nodes[0];
  const everyMs = Math.round(Number(minutes) * 60_000);
  const valid =
    entry !== undefined &&
    task.trim().length > 0 &&
    Number.isSafeInteger(everyMs) &&
    everyMs >= MIN_SCHEDULED_TASK_INTERVAL_MS;
  const environmentIds = [...new Set(props.nodes.map((node) => node.environmentId))];

  const create = async () => {
    if (!entry || !valid || busy) return;
    const shell = shells.find(
      (candidate) =>
        candidate.environmentId === entry.environmentId && candidate.id === entry.threadId,
    );
    if (!shell) {
      setError("The entry agent's thread is not loaded yet.");
      return;
    }
    if (!readEnvironmentScope(entry.environmentId, AuthOrchestrationOperateScope)) {
      setError("This machine does not allow scheduling.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await upsert({
      environmentId: entry.environmentId,
      input: {
        title: `Board: ${entry.name}`,
        prompt: buildStartMessage("scheduled", task.trim()),
        enabled: true,
        schedule: { type: "interval", everyMs },
        projectId: shell.projectId,
        threadId: shell.id,
        workspaceStrategy: { type: "root" },
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        creationSource: "web",
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setTask("");
  };

  return (
    <ToolbarPopover label="Schedule" icon={<ClockIcon />}>
      {props.nodes.length === 0 ? (
        <p className="text-muted-foreground">Add an agent to the board first.</p>
      ) : (
        <div className="grid gap-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Entry agent
            <select
              className={FIELD_CLASS}
              value={entry?.id ?? ""}
              onChange={(event) => setNodeId(event.target.value)}
            >
              {props.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Task
            <textarea
              className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
              placeholder="What should each scheduled run do?"
              value={task}
              onChange={(event) => setTask(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Interval (minutes, at least 1)
            <input
              className={FIELD_CLASS}
              type="number"
              min={1}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
            />
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div>
            <Button size="sm" disabled={!valid || busy} onClick={() => void create()}>
              Schedule this workflow
            </Button>
          </div>
          <div className="grid gap-2 border-t pt-2">
            {environmentIds.map((environmentId) => (
              <EnvironmentSchedules
                key={environmentId}
                environmentId={environmentId}
                nodes={props.nodes}
                onError={setError}
              />
            ))}
          </div>
        </div>
      )}
    </ToolbarPopover>
  );
}
