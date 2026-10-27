import { XIcon } from "lucide-react";

import type { RunRecord } from "../boardStore";
import { IconButton } from "./IconButton";
import { formatJson, formatRunTime, RUN_STATUS_LABELS } from "./runPresentation";

function JsonBlock(props: { readonly label: string; readonly value: unknown }) {
  if (props.value === undefined) return null;
  return (
    <details className="board-run-json">
      <summary>{props.label}</summary>
      <pre>{formatJson(props.value)}</pre>
    </details>
  );
}

/** Details of one past (or live) run: task, every request/return with its JSON, and the final result. */
export function RunDetails(props: { readonly run: RunRecord; readonly onClose: () => void }) {
  const { run } = props;
  return (
    <aside className="board-run-details" aria-label="Run details">
      <header>
        <div className="board-run-title">
          <span className="board-run-status" data-status={run.status}>
            <span className="runs-selector-dot" aria-hidden="true" />
            {RUN_STATUS_LABELS[run.status]}
          </span>
          <small>
            {formatRunTime(run.startedAt)}
            {run.endedAt ? ` - ${formatRunTime(run.endedAt)}` : ""}
          </small>
        </div>
        <IconButton label="Return to workflow" onClick={props.onClose}>
          <XIcon />
        </IconButton>
      </header>
      <div className="board-run-body">
        <section>
          <h3>Task</h3>
          <p>
            <strong>{run.nodeName}</strong>: {run.task}
          </p>
        </section>
        <section>
          <h3>Requests ({run.requests.length})</h3>
          {run.requests.length === 0 ? <p className="board-run-muted">No requests made.</p> : null}
          <ol>
            {run.requests.map((request) => (
              <li key={request.id} data-status={request.status}>
                <div className="board-run-request-head">
                  <span>
                    {request.from} {"->"} {request.to}
                  </span>
                  <small>{request.status}</small>
                </div>
                <p>{request.task}</p>
                <JsonBlock label="Request input" value={request.input} />
                {request.status === "returned" ? (
                  <>
                    <p className="board-run-return">
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
          <h3>Final result</h3>
          {run.status === "running" ? (
            <p className="board-run-muted">Still running.</p>
          ) : run.summary === undefined ? (
            <p className="board-run-muted">No final result ({RUN_STATUS_LABELS[run.status]}).</p>
          ) : (
            <>
              <p>{run.summary}</p>
              <JsonBlock label="Final data" value={run.data} />
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
