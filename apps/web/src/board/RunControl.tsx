import { PlayIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { useStopWorkflow } from "./BoardEngine";
import { useNodeCards } from "./toolbar/useNodeStatuses";
import { activeRunOf, appendLog, requestRun, useCurrentWorkflow } from "./boardStore";

const FIELD_CLASS = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

/** Foreman's run action: Run (entry agent + task), the Running chip while a run is live, and an always-visible Stop. */
export function RunControl() {
  const workflow = useCurrentWorkflow();
  const stopWorkflow = useStopWorkflow();
  const { nodes } = workflow;
  const [open, setOpen] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [task, setTask] = useState("");
  const [stopping, setStopping] = useState(false);
  const entry = nodes.find((node) => node.id === nodeId) ?? nodes[0];
  const canStart = entry !== undefined && task.trim().length > 0;
  const running = activeRunOf(workflow) !== undefined || workflow.runQueue.length > 0;

  const anyWorking = useNodeCards(workflow).some((card) => card.status === "working");

  const start = () => {
    if (!entry || !canStart) return;
    requestRun(entry.id, task.trim());
    appendLog("info", `Run requested at ${entry.name}.`, workflow.id);
    setTask("");
    setOpen(false);
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
                  Start run
                </Button>
              </div>
            </div>
          )}
        </PopoverPopup>
      </Popover>
      {running ? (
        <span role="status" className="board-live-run">
          <span className="board-live-run-dot" aria-hidden="true" />
          {stopping ? "Stopping" : "Running"}
        </span>
      ) : null}
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={stopping || !(running || anyWorking)}
        onClick={() => {
          setStopping(true);
          void stopWorkflow(workflow.id).finally(() => setStopping(false));
        }}
      >
        <SquareIcon />
        Stop
      </Button>
    </>
  );
}
