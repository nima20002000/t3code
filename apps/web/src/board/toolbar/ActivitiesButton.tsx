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
        <div className="flex max-h-[60vh] flex-col">
          <h2 className="border-b border-border px-3 py-2.5 text-sm font-semibold">Activities</h2>
          {props.log.length === 0 ? (
            <p className="px-3 py-2.5 text-2xs text-muted-foreground">Nothing has happened yet.</p>
          ) : null}
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
        </div>
      </PopoverPopup>
    </Popover>
  );
}
