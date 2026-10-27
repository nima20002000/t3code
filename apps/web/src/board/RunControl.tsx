import { PlayIcon, SquareIcon } from "lucide-react";
import { useRef, useState } from "react";

import { activeRunOf, useCurrentWorkflow } from "./boardStore";
import { runBoardMutation } from "./boardApi";
import {
  Button,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  randomUUID,
  toastManager,
} from "./upstream";

const FIELD_CLASS = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

/** Foreman's run action: Run (entry agent + task), the Running chip while a run is live, and an always-visible Stop. */
export function RunControl() {
  const workflow = useCurrentWorkflow();
  const { nodes } = workflow;
  const [open, setOpen] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [task, setTask] = useState("");
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const pendingStart = useRef<{ key: string; id: string } | null>(null);
  const entry = nodes.find((node) => node.id === nodeId) ?? nodes[0];
  const activeRun = activeRunOf(workflow);
  const running = activeRun !== undefined || workflow.runQueue.length > 0;
  const canStart = entry !== undefined && task.trim().length > 0 && !starting && !running;

  const start = () => {
    if (!entry || !canStart) return;
    setStarting(true);
    const key = JSON.stringify([workflow.id, entry.id, task.trim()]);
    const id = pendingStart.current?.key === key ? pendingStart.current.id : randomUUID();
    pendingStart.current = { key, id };
    void runBoardMutation((client) =>
      client.startRun({
        headers: {},
        params: { workflowId: workflow.id },
        payload: { id, nodeId: entry.id, task: task.trim() },
      }),
    )
      .then(() => {
        pendingStart.current = null;
        setTask("");
        setOpen(false);
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not start run",
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setStarting(false));
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button size="sm" aria-label="Run workflow" />}>
          <PlayIcon />
          Run
        </PopoverTrigger>
        <PopoverPopup width="lg" align="end">
          {nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Add an agent to the board first.</p>
          ) : (
            <div className="grid gap-3 text-sm">
              <label className="grid gap-1">
                Entry agent
                <select
                  className={FIELD_CLASS}
                  value={entry?.id ?? ""}
                  onChange={(event) => setNodeId(event.target.value)}
                >
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                Task
                <textarea
                  className={`${FIELD_CLASS} min-h-20 resize-y`}
                  autoFocus
                  placeholder="What should the workflow do?"
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) start();
                  }}
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={!canStart} onClick={start}>
                  {starting ? "Starting…" : "Start run"}
                </Button>
              </div>
            </div>
          )}
        </PopoverPopup>
      </Popover>
      {running ? (
        <span role="status" className="board-live-run">
          <span className="board-live-run-dot" aria-hidden="true" />
          {stopping || activeRun?.status === "stopping" ? "Stopping" : "Running"}
        </span>
      ) : null}
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={stopping || !activeRun}
        onClick={() => {
          setStopping(true);
          const run = activeRun;
          if (run)
            void runBoardMutation((client) =>
              client.stopRun({ headers: {}, params: { workflowId: workflow.id, runId: run.id } }),
            )
              .catch((error: unknown) =>
                toastManager.add({
                  type: "error",
                  title: "Could not stop run",
                  description: error instanceof Error ? error.message : String(error),
                }),
              )
              .finally(() => setStopping(false));
        }}
      >
        <SquareIcon />
        Stop
      </Button>
    </>
  );
}
