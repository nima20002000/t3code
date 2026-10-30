import { ClockIcon, Trash2Icon } from "lucide-react";
import type { BoardScheduleChats } from "@t3tools/board-core/http";
import { entryNodeOf } from "@t3tools/board-core/routing";
import { useState } from "react";

import { runBoardMutation } from "../boardApi";
import { useBoardSchedules, useCurrentWorkflow, type BoardNode } from "../boardStore";
import { ScheduleTimingFields } from "../ScheduleTimingFields";
import {
  scheduleLabel,
  scheduleSummary,
  timingFormOf,
  timingLabel,
  timingOf,
  type TimingForm,
} from "../scheduleTiming";
import { ToolbarPopover } from "./ToolbarPopover";
import { Button, randomUUID } from "../upstream";

export function ScheduleButton(props: { readonly nodes: ReadonlyArray<BoardNode> }) {
  const workflow = useCurrentWorkflow();
  const schedules = useBoardSchedules().filter((schedule) => schedule.workflowId === workflow.id);
  const [task, setTask] = useState("");
  const [timingForm, setTimingForm] = useState<TimingForm>(() => timingFormOf(null, ""));
  const [chats, setChats] = useState<BoardScheduleChats>("new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = entryNodeOf(props.nodes);
  const timing = timingOf(timingForm);
  const valid = entry !== undefined && task.trim().length > 0 && timing !== null;
  const create = async () => {
    if (!entry || !timing || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runBoardMutation((client) =>
        client.createSchedule({
          headers: {},
          payload: {
            id: randomUUID(),
            workflowId: workflow.id,
            task: task.trim(),
            ...timing,
            enabled: true,
            chats,
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
  const setEnabled = async (id: string, enabled: boolean) => {
    setError(null);
    try {
      await runBoardMutation((client) =>
        client.updateSchedule({ headers: {}, params: { scheduleId: id }, payload: { enabled } }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <ToolbarPopover label="Schedule" icon={<ClockIcon />}>
      {!entry ? (
        <p className="text-muted-foreground">Add an orchestrator to the board first.</p>
      ) : (
        <div className="grid gap-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Task
            <textarea
              className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
              placeholder="What should each scheduled run do?"
              value={task}
              onChange={(event) => setTask(event.target.value)}
            />
          </label>
          <ScheduleTimingFields
            form={timingForm}
            onChange={(patch) => setTimingForm((current) => ({ ...current, ...patch }))}
            clock="the hub's clock"
          />
          <label className="grid gap-1 text-xs text-muted-foreground">
            Chats for each run
            <select
              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
              value={chats}
              onChange={(event) => setChats(event.target.value as BoardScheduleChats)}
            >
              <option value="new">Start new chats first</option>
              <option value="continue">Continue the same chats, compact after the run</option>
            </select>
          </label>
          <div>
            <Button size="sm" disabled={!valid || busy} onClick={() => void create()}>
              Schedule this workflow
            </Button>
          </div>
        </div>
      )}
      <div className="grid gap-2 border-t pt-2">
        {schedules.map((schedule) => {
          const summary = scheduleSummary(schedule);
          const status = scheduleLabel(summary);
          return (
            <div key={schedule.id} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate">{schedule.task}</div>
                <div className="text-xs text-muted-foreground">
                  {timingLabel(schedule.timing)}
                  {schedule.chats === "continue" ? " · same chats" : ""}
                  {status ? ` · ${status}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {summary.state === "done" ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void setEnabled(schedule.id, !schedule.enabled)}
                  >
                    {schedule.enabled ? "Pause" : "Resume"}
                  </Button>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete schedule ${schedule.task}`}
                  onClick={() => void remove(schedule.id)}
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </ToolbarPopover>
  );
}
