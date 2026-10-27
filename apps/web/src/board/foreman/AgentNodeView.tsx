import { Tooltip, TooltipPopup, TooltipTrigger } from "../upstream";
import { type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { useHoverControls } from "./useHoverControls";

/** Visual state only; the caller maps runtime facts to one of these. */
export type AgentNodeState =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "unavailable";
/** A one-shot cue played when the state changes. */
export type AgentNodeTransition = "ignite" | "complete" | "fail" | "wait";
/** The three rim slots Foreman positions around the circle. */
export type AgentActionSlot = "chat" | "settings" | "info";

export interface AgentNodeAction {
  readonly slot: AgentActionSlot;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * Adapted from Foreman Code's AgentNodeView (shared/ui/nocturne/Canvas.tsx): a circle with harness
 * rim, status word, one-shot transition cues and rim actions. The popover and meta rows were
 * dropped, and a machine chip was added under the provider and model.
 */
export function AgentNodeView({
  name,
  harness,
  harnessLabel,
  model,
  machine,
  statusLabel,
  state = "idle",
  transition,
  transitionKey,
  selected,
  actions,
  children,
}: {
  name: string;
  harness: "codex" | "claude" | "neutral";
  harnessLabel: string;
  model?: string | null;
  machine: string;
  statusLabel: string;
  state?: AgentNodeState;
  transition?: AgentNodeTransition;
  /** Changes for every new cue, so the same cue twice in a row still plays twice. */
  transitionKey?: string | number;
  selected?: boolean;
  actions: ReadonlyArray<AgentNodeAction>;
  children?: ReactNode;
}) {
  const hover = useHoverControls();
  return (
    <div
      className="n-agent"
      data-state={state}
      data-transition={transition}
      data-harness={harness}
      data-selected={selected || undefined}
      data-hovered={hover.hovered || undefined}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
    >
      <span className="n-agent-energy" aria-hidden="true" />
      {transition ? (
        <span key={transitionKey ?? transition} className="n-agent-wave" aria-hidden="true">
          {transition === "ignite"
            ? Array.from({ length: 10 }, (_, index) => (
                <i key={index} style={{ "--spark": `${index * 36 + 8}deg` } as CSSProperties} />
              ))
            : null}
        </span>
      ) : null}
      <div
        className="n-agent-core"
        role="group"
        aria-label={`${name}, ${harnessLabel}${model ? `, ${model}` : ""}, ${statusLabel}`}
      >
        <span key={statusLabel} className="n-agent-status">
          <i aria-hidden="true" />
          {statusLabel}
        </span>
        <Tooltip>
          <TooltipTrigger render={<strong className="n-agent-name">{name}</strong>} />
          <TooltipPopup>{name}</TooltipPopup>
        </Tooltip>
        <span className="n-agent-harness">{harnessLabel}</span>
        {model ? (
          <Tooltip>
            <TooltipTrigger render={<span className="n-agent-model">{model}</span>} />
            <TooltipPopup>{model}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<span className="n-agent-machine">{machine}</span>} />
          <TooltipPopup>{machine}</TooltipPopup>
        </Tooltip>
      </div>
      <div className="n-agent-actions" role="group" aria-label={`${name} actions`}>
        {actions.map((action) => (
          <Tooltip key={action.slot}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={`n-agent-action n-agent-action--${action.slot} nodrag nopan`}
                  aria-label={action.label}
                  onClick={(event) => {
                    event.stopPropagation();
                    action.onClick(event);
                  }}
                >
                  {action.icon}
                </button>
              }
            />
            <TooltipPopup>{action.label}</TooltipPopup>
          </Tooltip>
        ))}
      </div>
      {children}
    </div>
  );
}
