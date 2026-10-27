import { HistoryIcon } from "lucide-react";

import type { BoardLogEntry } from "../boardStore";
import { IconButton } from "./IconButton";
import { formatRunTime } from "./runPresentation";
import { Popover, PopoverPopup, PopoverTrigger } from "../upstream";

/** Foreman-style Activities: an icon button opening a popover with the workflow log, newest first. */
export function ActivitiesButton(props: { readonly log: ReadonlyArray<BoardLogEntry> }) {
  return (
    <Popover>
      <PopoverTrigger render={<IconButton label="Activities" />}>
        <HistoryIcon />
      </PopoverTrigger>
      <PopoverPopup width="lg" align="end" padding="none">
        <div className="board-activities">
          <h2>Activities</h2>
          {props.log.length === 0 ? (
            <p className="board-run-muted">Nothing has happened yet.</p>
          ) : null}
          <ol>
            {props.log.map((entry) => (
              <li key={entry.id} data-kind={entry.kind}>
                <time dateTime={entry.at}>{formatRunTime(entry.at)}</time>
                <span>{entry.text}</span>
              </li>
            ))}
          </ol>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
