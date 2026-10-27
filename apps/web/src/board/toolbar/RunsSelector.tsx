import { CheckIcon, ChevronDownIcon } from "lucide-react";

import type { RunRecord } from "../boardStore";
import { formatRunTime, RUN_STATUS_LABELS } from "./runPresentation";
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
        render={<Button size="sm" variant="ghost" className="runs-selector-trigger" />}
        aria-label="Runs"
        title="Runs"
      >
        Runs <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverPopup width="lg" align="end" padding="none">
        <div role="menu" aria-label="Runs" className="runs-selector-menu">
          {props.runs.length > 0 ? (
            <div className="runs-selector-head" aria-hidden="true">
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
            className="runs-selector-option"
            onClick={() => props.onSelect(null)}
          >
            <span className="runs-selector-mark" aria-hidden="true">
              {props.selectedRunId === null ? <CheckIcon size={12} /> : null}
            </span>
            <span style={{ gridColumn: "2 / -1" }}>Workflow (no run selected)</span>
          </button>
          {props.runs.map((run) => (
            <button
              key={run.id}
              type="button"
              role="menuitemradio"
              aria-checked={props.selectedRunId === run.id}
              className="runs-selector-option"
              data-status={run.status}
              onClick={() => props.onSelect(run.id)}
            >
              <span className="runs-selector-mark" aria-hidden="true">
                {props.selectedRunId === run.id ? <CheckIcon size={12} /> : null}
              </span>
              <span className="runs-selector-status">
                <span className="runs-selector-dot" aria-hidden="true" />
                {RUN_STATUS_LABELS[run.status]}
              </span>
              <span className="runs-selector-time">{formatRunTime(run.startedAt)}</span>
              <span className="runs-selector-entry">{run.nodeName}</span>
            </button>
          ))}
          {props.runs.length === 0 ? <p className="runs-selector-state">No runs yet</p> : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
