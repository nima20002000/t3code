import type { RunRequestRecord, Workflow } from "@t3tools/board-core/boardModel";
import { runToShow } from "@t3tools/board-core/runView";
import { XIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { formatRunTime } from "./toolbar/runPresentation";

export type ActivityTarget =
  | { readonly kind: "node"; readonly nodeId: string }
  | { readonly kind: "edge"; readonly from: string; readonly to: string };

const STATUS_WORDS: Record<RunRequestRecord["status"], string> = {
  pending: "Working",
  returned: "Returned",
  denied: "Denied",
  dropped: "Dropped",
  failed: "Failed",
  stopped: "Stopped",
};

function RequestRow({ request }: { readonly request: RunRequestRecord }) {
  return (
    <li className="grid gap-0.5 border-t py-1.5 first:border-t-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">
          {request.from} → {request.to}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {STATUS_WORDS[request.status]} · {formatRunTime(request.returnedAt ?? request.at)}
        </span>
      </div>
      <p className="line-clamp-3 text-xs text-foreground/80" title={request.task}>
        {request.task}
      </p>
      {request.returnSummary ? (
        <p className="line-clamp-3 text-xs text-muted-foreground" title={request.returnSummary}>
          ↩ {request.returnSummary}
        </p>
      ) : request.failureReason ? (
        <p className="text-xs text-destructive">{request.failureReason}</p>
      ) : null}
    </li>
  );
}

/** What crossed a node or an edge in the drawn run: each request, its state and its return. */
export function RunActivityCard(props: {
  readonly workflow: Workflow;
  readonly target: ActivityTarget;
  readonly onClose: () => void;
}) {
  const { workflow, target } = props;
  const run = runToShow(workflow.runs);
  const name = (id: string) => workflow.nodes.find((node) => node.id === id)?.name ?? "Removed";
  const requests = (run?.requests ?? []).filter((request) =>
    target.kind === "node"
      ? request.fromId === target.nodeId || request.toId === target.nodeId
      : request.fromId === target.from && request.toId === target.to,
  );
  const title =
    target.kind === "node" ? name(target.nodeId) : `${name(target.from)} → ${name(target.to)}`;
  const entry = target.kind === "node" && run?.nodeId === target.nodeId;
  return (
    <aside
      aria-label={`${title} activity`}
      className="absolute bottom-3 left-3 z-20 flex max-h-[45%] w-[360px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border bg-background shadow-lg"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          <p className="text-xs text-muted-foreground">
            {run ? `Run ${formatRunTime(run.startedAt)} · ${run.status}` : "No runs yet"}
          </p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close activity" onClick={props.onClose}>
          <XIcon size={15} />
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto px-3 py-1">
        {entry ? (
          <p className="border-b py-1.5 text-xs">
            <span className="font-medium">Entry task:</span> {run.task}
            {run.summary ? (
              <span className="block text-muted-foreground">↩ {run.summary}</span>
            ) : null}
          </p>
        ) : null}
        {requests.length ? (
          <ul>
            {requests.toReversed().map((request) => (
              <RequestRow key={request.id} request={request} />
            ))}
          </ul>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">Nothing crossed here in this run.</p>
        )}
      </div>
    </aside>
  );
}
