import { ArrowLeftIcon, ChevronRightIcon, HistoryIcon } from "lucide-react";
import { useState } from "react";

import type { BoardLogEntry, RunRecord } from "../boardStore";
import { IconButton } from "./IconButton";
import { formatRunTime, retryReasons, runStatusDot, runStatusLabel } from "./runPresentation";
import { Button, Popover, PopoverPopup, PopoverTrigger } from "../upstream";

function LogList(props: { readonly log: ReadonlyArray<BoardLogEntry> }) {
  if (props.log.length === 0)
    return <p className="px-3 py-2.5 text-2xs text-muted-foreground">Nothing has happened yet.</p>;
  return (
    <ol className="overflow-y-auto">
      {props.log.map((entry) => (
        <li
          key={entry.id}
          className="grid gap-0.5 border-b border-border/50 px-3 py-2 text-xs break-words"
        >
          <time dateTime={entry.at} className="text-2xs text-muted-foreground">
            {formatRunTime(entry.at)}
          </time>
          <span
            className={
              entry.kind === "error"
                ? "text-destructive-foreground"
                : entry.kind === "run"
                  ? "font-semibold"
                  : undefined
            }
          >
            {entry.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A workflow has one run at a time, so a run's activity is the log between its start and end. */
function runLog(log: ReadonlyArray<BoardLogEntry>, run: RunRecord) {
  return log.filter(
    (entry) => entry.at >= run.startedAt && (run.endedAt === undefined || entry.at <= run.endedAt),
  );
}

/** Activities: the workflow's runs, newest first; picking one shows its activity, with Back. */
export function ActivitiesButton(props: {
  readonly log: ReadonlyArray<BoardLogEntry>;
  readonly runs: ReadonlyArray<RunRecord>;
  readonly onShowRun: (runId: string) => void;
}) {
  const [runId, setRunId] = useState<string | "all" | null>(null);
  const run = props.runs.find((entry) => entry.id === runId);
  const runs = props.runs.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <Popover onOpenChange={(open) => (open ? undefined : setRunId(null))}>
      <PopoverTrigger render={<IconButton label="Activities" />}>
        <HistoryIcon />
      </PopoverTrigger>
      <PopoverPopup width="lg" align="end" padding="none">
        <div className="flex max-h-[60vh] flex-col">
          {runId === null ? (
            <>
              <h2 className="border-b border-border px-3 py-2.5 text-sm font-semibold">
                Activities
              </h2>
              <div className="overflow-y-auto">
                <RunRow label="All activity" onClick={() => setRunId("all")} />
                {runs.map((entry) => (
                  <RunRow
                    key={entry.id}
                    label={entry.task}
                    run={entry}
                    onClick={() => setRunId(entry.id)}
                  />
                ))}
                {runs.length === 0 ? (
                  <p className="px-3 py-2.5 text-2xs text-muted-foreground">No runs yet.</p>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <header className="flex items-center gap-1 border-b border-border py-1.5 pr-2 pl-1">
                <IconButton label="Back to runs" onClick={() => setRunId(null)}>
                  <ArrowLeftIcon />
                </IconButton>
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {run ? run.task : "All activity"}
                </h2>
                {run ? (
                  <Button size="xs" variant="ghost" onClick={() => props.onShowRun(run.id)}>
                    Details
                  </Button>
                ) : null}
              </header>
              {run
                ? retryReasons(run).map((reason) => (
                    <p
                      key={reason}
                      className="border-b border-border/50 px-3 py-2 text-xs break-words text-warning"
                    >
                      {reason}
                    </p>
                  ))
                : null}
              <LogList log={run ? runLog(props.log, run) : props.log} />
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function RunRow(props: {
  readonly label: string;
  readonly run?: RunRecord;
  readonly onClick: () => void;
}) {
  const { run } = props;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs hover:bg-accent focus-visible:bg-accent"
      onClick={props.onClick}
    >
      {run ? (
        <span
          className={`size-2 flex-none rounded-full ${runStatusDot(run)}`}
          aria-label={runStatusLabel(run)}
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{props.label}</span>
        {run ? (
          <small className="text-2xs text-muted-foreground">
            {runStatusLabel(run)} · {formatRunTime(run.startedAt)}
          </small>
        ) : null}
      </span>
      <ChevronRightIcon className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
