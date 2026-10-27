import { type MouseEvent, type ReactNode } from "react";

import { useHoverControls } from "./useHoverControls";

/** Visual state only; the caller maps runtime facts to one of these. */
export type AgentNodeState = "idle" | "running" | "unavailable";
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
 * rim, status word and rim actions. The popover, transition cues and meta rows were dropped, and a
 * machine chip was added under the provider and model.
 */
export function AgentNodeView({
  name,
  harness,
  harnessLabel,
  model,
  machine,
  statusLabel,
  state = "idle",
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
  selected?: boolean;
  actions: ReadonlyArray<AgentNodeAction>;
  children?: ReactNode;
}) {
  const hover = useHoverControls();
  return (
    <div
      className="n-agent"
      data-state={state}
      data-harness={harness}
      data-selected={selected || undefined}
      data-hovered={hover.hovered || undefined}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
    >
      <span className="n-agent-energy" aria-hidden="true" />
      <div
        className="n-agent-core"
        role="group"
        aria-label={`${name}, ${harnessLabel}${model ? `, ${model}` : ""}, ${statusLabel}`}
      >
        <span key={statusLabel} className="n-agent-status">
          <i aria-hidden="true" />
          {statusLabel}
        </span>
        <strong className="n-agent-name" title={name}>
          {name}
        </strong>
        <span className="n-agent-harness">{harnessLabel}</span>
        {model ? (
          <span className="n-agent-model" title={model}>
            {model}
          </span>
        ) : null}
        <span className="n-agent-machine" title={machine}>
          {machine}
        </span>
      </div>
      <div className="n-agent-actions" role="group" aria-label={`${name} actions`}>
        {actions.map((action) => (
          <button
            key={action.slot}
            type="button"
            className={`n-agent-action n-agent-action--${action.slot} nodrag nopan`}
            aria-label={action.label}
            title={action.label}
            onClick={(event) => {
              event.stopPropagation();
              action.onClick(event);
            }}
          >
            {action.icon}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
