import { CheckIcon, ListIcon } from "lucide-react";

import type { RunRecord } from "../boardStore";
import { formatRunTime, RUN_STATUS_DOT, RUN_STATUS_LABELS } from "./runPresentation";
import { Button, Popover, PopoverPopup, PopoverTrigger } from "../upstream";

/** Foreman-style Runs selector: lists past runs; picking one shows its details over the board. */
export function RunsSelector(props: {
  readonly runs: ReadonlyArray<RunRecord>;
  readonly selectedRunId: string | null;
  readonly onSelect: (runId: string | null) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="icon-sm" variant="ghost" />}
        aria-label="Runs"
        title="Runs"
      >
        <ListIcon />
      </PopoverTrigger>
      <PopoverPopup width="lg" align="end" padding="none">
        <div
          role="menu"
          aria-label="Runs"
          className="max-h-[60vh] overflow-y-auto overscroll-contain"
        >
          {props.runs.length > 0 ? (
            <div
              className="runs-selector-row sticky top-0 z-1 min-h-7.5 border-b border-border bg-popover text-2xs tracking-wide text-muted-foreground uppercase"
              aria-hidden="true"
            >
              <span />
              <span>Status</span>
              <span>Started</span>
              <span>Entry</span>
            </div>
          ) : null}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={props.selectedRunId === null}
            className={`runs-selector-row min-h-9.5 cursor-pointer border-b border-border/50 text-xs whitespace-nowrap hover:bg-accent focus-visible:bg-accent ${props.selectedRunId === null ? "font-semibold" : ""}`}
            onClick={() => props.onSelect(null)}
          >
            <span className="text-primary" aria-hidden="true">
              {props.selectedRunId === null ? <CheckIcon size={12} /> : null}
            </span>
            <span style={{ gridColumn: "2 / -1" }}>Workflow (no run selected)</span>
          </button>
          {props.runs
            .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
            .map((run) => (
              <button
                key={run.id}
                type="button"
                role="menuitemradio"
                aria-checked={props.selectedRunId === run.id}
                className={`runs-selector-row min-h-9.5 cursor-pointer border-b border-border/50 text-xs whitespace-nowrap hover:bg-accent focus-visible:bg-accent ${props.selectedRunId === run.id ? "font-semibold" : ""}`}
                onClick={() => props.onSelect(run.id)}
              >
                <span className="text-primary" aria-hidden="true">
                  {props.selectedRunId === run.id ? <CheckIcon size={12} /> : null}
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs">
                  <span
                    className={`size-2 flex-none rounded-full ${RUN_STATUS_DOT[run.status]}`}
                    aria-hidden="true"
                  />
                  {RUN_STATUS_LABELS[run.status]}
                </span>
                <span>{formatRunTime(run.startedAt)}</span>
                <span className="text-muted-foreground">{run.nodeName}</span>
              </button>
            ))}
          {props.runs.length === 0 ? (
            <p className="m-0 px-3 py-2 text-xs text-muted-foreground">No runs yet</p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
