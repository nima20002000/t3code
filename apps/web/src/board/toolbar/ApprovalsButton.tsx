import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { BellIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";
import { useQuietThreadShells } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { BoardNode } from "../boardStore";
import { ToolbarPopover, useMachineLabel } from "./ToolbarPopover";

type Reply = (failure: string | null) => void;

function UserInputCard(props: {
  readonly node: BoardNode;
  readonly request: ReturnType<typeof derivePendingUserInputs>[number];
  readonly onError: Reply;
}) {
  const { node, request } = props;
  const respond = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [busy, setBusy] = useState(false);
  const answers = buildPendingUserInputAnswers(request.questions, drafts);
  const canRespond =
    request.responseCapability !== "not_resumable" &&
    readEnvironmentScope(node.environmentId, AuthOrchestrationOperateScope);

  const toggle = (questionId: string, multi: boolean, value: string) =>
    setDrafts((current) => {
      const selected = current[questionId]?.selectedOptionValues ?? [];
      const next = multi
        ? selected.includes(value)
          ? selected.filter((entry) => entry !== value)
          : [...selected, value]
        : [value];
      return { ...current, [questionId]: { selectedOptionValues: next } };
    });

  const submit = async () => {
    if (!answers || busy) return;
    setBusy(true);
    const result = await respond({
      environmentId: node.environmentId,
      input: { threadId: node.threadId, requestId: request.requestId, answers },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      props.onError(error instanceof Error ? error.message : "Failed to submit the answer.");
    }
  };

  return (
    <div className="grid gap-2">
      {request.questions.map((question) => (
        <div key={question.id} className="grid gap-1">
          <div className="text-xs text-muted-foreground">{question.header}</div>
          <div>{question.question}</div>
          <div className="flex flex-wrap gap-1">
            {question.options.map((option) => {
              const value = option.value ?? option.label;
              const selected = drafts[question.id]?.selectedOptionValues?.includes(value) ?? false;
              return (
                <Button
                  key={value}
                  size="xs"
                  variant={selected ? "default" : "outline"}
                  title={option.description}
                  disabled={!canRespond}
                  onClick={() => toggle(question.id, question.multiSelect, value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
          {question.allowCustomAnswer === false ? null : (
            <input
              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
              placeholder="Custom answer"
              disabled={!canRespond}
              value={drafts[question.id]?.customAnswer ?? ""}
              onChange={(event) =>
                setDrafts((current) => ({
                  ...current,
                  [question.id]: { customAnswer: event.target.value },
                }))
              }
            />
          )}
        </div>
      ))}
      <div>
        <Button size="xs" disabled={!canRespond || !answers || busy} onClick={() => void submit()}>
          Send answer
        </Button>
      </div>
    </div>
  );
}

function NodeRequests(props: { readonly node: BoardNode; readonly onError: Reply }) {
  const { node } = props;
  const machineLabel = useMachineLabel();
  const pending = useAtomValue(
    environmentThreadDetails.pendingRequestsAtom(scopeThreadRef(node.environmentId, node.threadId)),
  );
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const [responding, setResponding] = useState<ReadonlyArray<RuntimeRequestId>>([]);
  if (!pending) return null;
  const approvals = derivePendingApprovals(pending.approvals);
  const userInputs = derivePendingUserInputs(pending.userInputs);
  const canOperate = readEnvironmentScope(node.environmentId, AuthOrchestrationOperateScope);

  const decide = async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
    setResponding((current) => [...current, requestId]);
    const result = await respondToApproval({
      environmentId: node.environmentId,
      input: { threadId: node.threadId, requestId, decision },
    });
    setResponding((current) => current.filter((id) => id !== requestId));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      props.onError(error instanceof Error ? error.message : "Failed to submit the decision.");
    }
  };

  const header = (
    <div className="flex items-baseline justify-between gap-2">
      <span className="truncate font-medium">{node.name}</span>
      <span className="truncate text-xs text-muted-foreground">
        {machineLabel(node.environmentId)}
      </span>
    </div>
  );

  return (
    <>
      {approvals.map((approval) => (
        <div key={approval.requestId} className="grid gap-1.5 rounded-md border p-2">
          {header}
          <div className="text-xs text-muted-foreground">Approval: {approval.requestKind}</div>
          {approval.detail ? (
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-xs">
              {approval.detail}
            </pre>
          ) : null}
          {approval.reason ? <div className="text-xs">{approval.reason}</div> : null}
          <div className="flex gap-1">
            <Button
              size="xs"
              disabled={
                !canOperate ||
                approval.responseCapability !== "live" ||
                responding.includes(approval.requestId)
              }
              onClick={() => void decide(approval.requestId, "accept")}
            >
              Approve
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={
                !canOperate ||
                approval.responseCapability !== "live" ||
                responding.includes(approval.requestId)
              }
              onClick={() => void decide(approval.requestId, "decline")}
            >
              Deny
            </Button>
          </div>
        </div>
      ))}
      {userInputs.map((request) => (
        <div key={request.requestId} className="grid gap-1.5 rounded-md border p-2">
          {header}
          <UserInputCard node={node} request={request} onError={props.onError} />
        </div>
      ))}
    </>
  );
}

/**
 * Approval inbox: pending approvals and user-input questions across every node thread, on any
 * connected machine. Reads t3's own per-thread pending requests (`pendingRequestsAtom`) and
 * answers with the thread view's `respondToApproval` / `respondToUserInput` commands.
 */
export function ApprovalsButton(props: { readonly nodes: ReadonlyArray<BoardNode> }) {
  const shells = useQuietThreadShells();
  const [error, setError] = useState<string | null>(null);
  // Thread shells carry only pending flags, so the badge counts nodes that are waiting.
  const waiting = props.nodes.filter((node) =>
    shells.some(
      (shell) =>
        shell.environmentId === node.environmentId &&
        shell.id === node.threadId &&
        (shell.hasPendingApprovals || shell.hasPendingUserInput),
    ),
  );

  return (
    <ToolbarPopover label="Approvals" icon={<BellIcon />} badge={waiting.length}>
      {waiting.length === 0 ? <p className="text-muted-foreground">Nothing is waiting.</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="grid max-h-96 gap-2 overflow-y-auto">
        {waiting.map((node) => (
          <NodeRequests key={node.id} node={node} onError={setError} />
        ))}
      </div>
    </ToolbarPopover>
  );
}
