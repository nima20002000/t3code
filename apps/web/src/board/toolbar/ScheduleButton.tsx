import { ClockIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { randomUUID } from "../../lib/utils";
import { runBoardMutation } from "../boardApi";
import { useBoardSchedules, useCurrentWorkflow, type BoardNode } from "../boardStore";
import { ToolbarPopover } from "./ToolbarPopover";

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";

export function ScheduleButton(props: { readonly nodes: ReadonlyArray<BoardNode> }) {
  const workflow = useCurrentWorkflow();
  const schedules = useBoardSchedules().filter((schedule) => schedule.workflowId === workflow.id);
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
    everyMs >= 60_000;
  const create = async () => {
    if (!entry || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runBoardMutation((client) =>
        client.createSchedule({
          headers: {},
          payload: {
            id: randomUUID(),
            workflowId: workflow.id,
            nodeId: entry.id,
            task: task.trim(),
            everyMs,
            enabled: true,
          },
        }),
      );
      setTask("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setError(null);
    try {
      await runBoardMutation((client) =>
        client.deleteSchedule({ headers: {}, params: { scheduleId: id } }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
          <div>
            <Button size="sm" disabled={!valid || busy} onClick={() => void create()}>
              Schedule this workflow
            </Button>
          </div>
        </div>
      )}
      <div className="grid gap-2 border-t pt-2">
        {schedules.map((schedule) => (
          <div key={schedule.id} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate">{schedule.task}</div>
              <div className="text-xs text-muted-foreground">
                Every {schedule.everyMs / 60_000} min · {schedule.enabled ? "enabled" : "paused"}
              </div>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete schedule ${schedule.task}`}
              onClick={() => void remove(schedule.id)}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </ToolbarPopover>
  );
}
