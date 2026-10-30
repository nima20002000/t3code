import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon, XIcon } from "lucide-react";

import type { RunRecord } from "../boardStore";
import { buildThreadRouteParams } from "../upstream";
import { IconButton } from "./IconButton";
import {
  formatJson,
  formatRunTime,
  retryReasons,
  RUN_STATUS_LABELS,
  runStatusDot,
  runStatusLabel,
} from "./runPresentation";

const SECTION_HEADING = "mb-1 text-2xs uppercase tracking-wider text-muted-foreground";

function JsonBlock(props: { readonly label: string; readonly value: unknown }) {
  if (props.value === undefined) return null;
  return (
    <details>
      <summary className="cursor-pointer text-2xs text-muted-foreground">{props.label}</summary>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-1.5 font-mono text-2xs leading-4">
        {formatJson(props.value)}
      </pre>
    </details>
  );
}

/** Details of one past (or live) run: task, every request/return with its JSON, and the final result. */
export function RunDetails(props: { readonly run: RunRecord; readonly onClose: () => void }) {
  const { run } = props;
  const navigate = useNavigate();
  const threads = run.definition.nodes.flatMap((node) => {
    const thread = run.threads[node.id];
    return thread ? [{ node, thread }] : [];
  });
  return (
    <aside
      className="board-run-details flex flex-col rounded-xl border border-border bg-card text-sm text-foreground shadow-lg"
      aria-label="Run details"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border py-2 pr-2 pl-3">
        <div className="grid gap-0.5">
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span
              className={`size-2 flex-none rounded-full ${runStatusDot(run)}`}
              aria-hidden="true"
            />
            {runStatusLabel(run)}
          </span>
          <small className="text-2xs text-muted-foreground">
            {formatRunTime(run.startedAt)}
            {run.endedAt ? ` - ${formatRunTime(run.endedAt)}` : ""}
          </small>
        </div>
        <IconButton label="Return to workflow" onClick={props.onClose}>
          <XIcon />
        </IconButton>
      </header>
      <div className="grid min-h-0 flex-1 content-start gap-3.5 overflow-y-auto p-3">
        {retryReasons(run).map((reason) => (
          <p key={reason} className="break-words text-xs text-warning">
            {reason}
          </p>
        ))}
        <section>
          <h3 className={SECTION_HEADING}>Task</h3>
          <p className="break-words">
            <strong>{run.nodeName}</strong>: {run.task}
          </p>
        </section>
        <section>
          <h3 className={SECTION_HEADING}>Threads ({threads.length})</h3>
          {threads.length === 0 ? (
            <p className="text-2xs text-muted-foreground">No agent has started a thread yet.</p>
          ) : null}
          <ul className="grid gap-1">
            {threads.map(({ node, thread }) => (
              <li key={node.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(thread.environmentId, thread.threadId),
                      ),
                    })
                  }
                >
                  <MessageSquareIcon size={13} aria-hidden="true" />
                  <span className="truncate">{node.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className={SECTION_HEADING}>Requests ({run.requests.length})</h3>
          {run.requests.length === 0 ? (
            <p className="text-2xs text-muted-foreground">No requests made.</p>
          ) : null}
          <ol className="grid gap-2">
            {run.requests.map((request) => (
              <li
                key={request.id}
                className={`grid gap-1 rounded-lg border p-2 ${request.status === "denied" ? "border-destructive/45" : "border-border"}`}
              >
                <div className="flex justify-between gap-2 font-semibold">
                  <span>
                    {request.from} {"->"} {request.to}
                  </span>
                  <small className="font-normal text-muted-foreground">{request.status}</small>
                </div>
                <p className="break-words">{request.task}</p>
                <JsonBlock label="Request input" value={request.input} />
                {request.status === "returned" ? (
                  <>
                    <p className="break-words text-success">
                      Return ({formatRunTime(request.returnedAt)}): {request.returnSummary}
                    </p>
                    <JsonBlock label="Return data" value={request.returnData} />
                  </>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
        <section>
          <h3 className={SECTION_HEADING}>Final result</h3>
          {run.status === "running" ? (
            <p className="text-2xs text-muted-foreground">Still running.</p>
          ) : run.summary === undefined ? (
            <p className="text-2xs text-muted-foreground">
              No final result ({RUN_STATUS_LABELS[run.status]}).
            </p>
          ) : (
            <>
              <p className="break-words">{run.summary}</p>
              <JsonBlock label="Final data" value={run.data} />
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
