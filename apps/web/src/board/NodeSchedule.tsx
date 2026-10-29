import { ClockIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ScheduledTask } from "@t3tools/contracts";

import {
  deleteNodeSchedule,
  saveNodeSchedule,
  setNodeScheduleEnabled,
  syncNodeSchedule,
  type BoardNode,
} from "./boardStore";
import {
  formOf,
  scheduleInput,
  scheduleLabel,
  scheduleSummary,
  type ScheduleForm,
} from "./nodeSchedule";
import {
  Button,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  serverEnvironment,
  useEnvironmentQuery,
} from "./upstream";

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The agent's schedule: a clock on the node that shows runs left and opens the editor. */
export function NodeScheduleButton({ node }: { readonly node: BoardNode }) {
  const marker = node.schedule;
  const query = useEnvironmentQuery(
    marker
      ? serverEnvironment.scheduledTasksLive({ environmentId: marker.environmentId, input: {} })
      : null,
  );
  const task = marker
    ? (query.data?.tasks.find((entry) => entry.id === marker.taskId) ?? null)
    : null;
  const firedThread = task?.threadId ?? null;
  const chatThread = node.chat?.threadId ?? null;
  // oxlint-disable-next-line t3code/react-effect-budget -- A "new chat" firing moved the task on its machine; the hub's chat follows.
  useEffect(() => {
    if (firedThread !== null && chatThread !== null && firedThread !== chatThread)
      syncNodeSchedule(node.id);
  }, [firedThread, chatThread, node.id]);
  const summary = task ? scheduleSummary(task) : null;
  const label = summary ? scheduleLabel(summary) : null;
  return (
    <span className="contents" onClick={(event) => event.stopPropagation()}>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={`${label ? "n-agent-schedule" : "n-agent-chat"} nodrag nopan`}
              aria-label={`${node.name} schedule${label ? `: ${label}` : ""}`}
              data-state={summary?.state}
            />
          }
        >
          <ClockIcon size={14} />
          {label ? <span>{label}</span> : null}
        </PopoverTrigger>
        <PopoverPopup width="lg" align="center">
          <ScheduleEditor node={node} task={task} />
        </PopoverPopup>
      </Popover>
    </span>
  );
}

function ScheduleEditor(props: { readonly node: BoardNode; readonly task: ScheduledTask | null }) {
  const { node, task } = props;
  const [form, setForm] = useState<ScheduleForm>(() => formOf(task));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = scheduleInput(form);
  const summary = task ? scheduleSummary(task) : null;
  const patch = (next: Partial<ScheduleForm>) => setForm((current) => ({ ...current, ...next }));
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2 text-sm">
      <div className="font-medium">{node.name} schedule</div>
      {summary ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{scheduleLabel(summary) || "Scheduled"}</span>
          <span className="flex items-center gap-1">
            {summary.state === "done" ? null : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(() => setNodeScheduleEnabled(node.id, summary.state === "paused"))
                }
              >
                {summary.state === "paused" ? "Resume" : "Pause"}
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Delete schedule"
              disabled={busy}
              onClick={() => void run(() => deleteNodeSchedule(node.id))}
            >
              <Trash2Icon />
            </Button>
          </span>
        </div>
      ) : null}
      <label className="grid gap-1 text-xs text-muted-foreground">
        Prompt
        <textarea
          className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
          placeholder="What should the agent do each time?"
          value={form.prompt}
          onChange={(event) => patch({ prompt: event.target.value })}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        When
        <select
          className={FIELD_CLASS}
          value={form.mode}
          onChange={(event) => patch({ mode: event.target.value as ScheduleForm["mode"] })}
        >
          <option value="interval">Every few minutes</option>
          <option value="time">At a time of day</option>
        </select>
      </label>
      {form.mode === "interval" ? (
        <label className="grid gap-1 text-xs text-muted-foreground">
          Every (minutes, at least 1)
          <input
            className={FIELD_CLASS}
            type="number"
            min={1}
            value={form.minutes}
            onChange={(event) => patch({ minutes: event.target.value })}
          />
        </label>
      ) : (
        <div className="grid gap-1 text-xs text-muted-foreground">
          <label className="grid gap-1">
            Time (the machine's clock)
            <input
              className={FIELD_CLASS}
              type="time"
              value={form.timeOfDay}
              onChange={(event) => patch({ timeOfDay: event.target.value })}
            />
          </label>
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="Days (none means every day)"
          >
            {WEEKDAYS.map((day, index) => {
              const on = form.weekdays.includes(index);
              return (
                <Button
                  key={day}
                  size="micro"
                  variant={on ? "default" : "outline"}
                  aria-pressed={on}
                  onClick={() =>
                    patch({
                      weekdays: on
                        ? form.weekdays.filter((entry) => entry !== index)
                        : [...form.weekdays, index],
                    })
                  }
                >
                  {day}
                </Button>
              );
            })}
          </div>
        </div>
      )}
      <label className="grid gap-1 text-xs text-muted-foreground">
        Times
        <input
          className={FIELD_CLASS}
          type="number"
          min={1}
          value={form.runs}
          onChange={(event) => patch({ runs: event.target.value })}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Before each firing
        <select
          className={FIELD_CLASS}
          value={form.beforeRun}
          onChange={(event) =>
            patch({ beforeRun: event.target.value as ScheduleForm["beforeRun"] })
          }
        >
          <option value="compact">Compact the chat</option>
          <option value="new_thread">Start a new chat</option>
          <option value="none">Nothing</option>
        </select>
      </label>
      <div>
        <Button
          size="sm"
          disabled={input === null || busy}
          onClick={() => {
            if (input) void run(() => saveNodeSchedule(node.id, input));
          }}
        >
          {task ? "Save schedule" : "Schedule"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
