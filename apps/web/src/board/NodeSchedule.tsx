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
import { useNodeConnections } from "./useNodeConnection";
import { formOf, scheduleInput, type ScheduleForm } from "./nodeSchedule";
import { ScheduleTimingFields } from "./ScheduleTimingFields";
import { scheduleLabel, scheduleSummary } from "./scheduleTiming";
import {
  Button,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  serverEnvironment,
  useEnvironmentQuery,
} from "./upstream";

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";

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
  const connected = useNodeConnections()(marker?.environmentId ?? "") === "connected";
  // The hub reaches paired machines the browser may not be connected to; their tasks are unseen.
  const unseen = marker !== undefined && task === null && (!connected || query.data === null);
  const summary = task ? scheduleSummary(task) : null;
  const label = summary ? scheduleLabel(summary) : unseen ? "Scheduled" : null;
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
          {unseen ? (
            <UnseenSchedule node={node} loading={connected} />
          ) : (
            <ScheduleEditor key={task?.id ?? "new"} node={node} task={task} />
          )}
        </PopoverPopup>
      </Popover>
    </span>
  );
}

function UnseenSchedule(props: { readonly node: BoardNode; readonly loading: boolean }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2 text-sm">
      <div className="font-medium">{props.node.name} schedule</div>
      <p className="text-xs text-muted-foreground">
        {props.loading
          ? "Loading the schedule from the agent's machine…"
          : "Connect this machine in Settings → Connections to see and edit its schedule."}
      </p>
      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void deleteNodeSchedule(props.node.id).catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            )
          }
        >
          <Trash2Icon />
          Delete schedule
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
      <ScheduleTimingFields
        form={form.timing}
        onChange={(timing) => patch({ timing: { ...form.timing, ...timing } })}
        clock="the machine's clock"
      />
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
