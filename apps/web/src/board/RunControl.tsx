import { PlayIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { appendLog, requestRun, useCurrentWorkflow } from "./boardStore";

/** Foreman-style Run control: pick the entry node, type a task, queue the run. */
export function RunControl() {
  const { nodes } = useCurrentWorkflow();
  const [open, setOpen] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [task, setTask] = useState("");
  const entry = nodes.find((node) => node.id === nodeId) ?? nodes[0];
  const canStart = entry !== undefined && task.trim().length > 0;

  const start = () => {
    if (!entry || !canStart) return;
    requestRun(entry.id, task.trim());
    appendLog("info", `Run requested at ${entry.name}.`);
    setTask("");
    setOpen(false);
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen((value) => !value)}>
        <PlayIcon />
        Run
      </Button>
      {open ? (
        <div className="board-popover" role="dialog" aria-label="Run workflow">
          {nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Add an agent to the board first.</p>
          ) : (
            <>
              <label>
                Entry agent
                <select value={entry?.id ?? ""} onChange={(event) => setNodeId(event.target.value)}>
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Task
                <textarea
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
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
