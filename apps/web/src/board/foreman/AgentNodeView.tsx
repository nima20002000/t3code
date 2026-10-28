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
export interface AgentNodeChat {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * Adapted from Foreman Code's AgentNodeView (shared/ui/nocturne/Canvas.tsx): a circle with harness
 * rim, status word and one-shot transition cues. It shows only the status, name, role and machine,
 * with the chat button inside the circle; harness and model are in the name's tooltip.
 */
export function AgentNodeView({
  name,
  harness,
  harnessLabel,
  model,
  machine,
  role,
  statusLabel,
  state = "idle",
  transition,
  transitionKey,
  selected,
  size,
  chat,
  children,
}: {
  name: string;
  harness: "codex" | "claude" | "neutral";
  harnessLabel: string;
  model?: string | null;
  machine: string;
  role: string;
  statusLabel: string;
  state?: AgentNodeState;
  transition?: AgentNodeTransition;
  /** Changes for every new cue, so the same cue twice in a row still plays twice. */
  transitionKey?: string | number;
  selected?: boolean;
  /** Diameter in px; the stylesheet's default when unset. */
  size?: number;
  chat: AgentNodeChat;
  children?: ReactNode;
}) {
  const hover = useHoverControls();
  return (
    <div
      className="n-agent"
      style={size === undefined ? undefined : ({ "--agent-size": `${size}px` } as CSSProperties)}
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
          <TooltipPopup>
            {name} · {harnessLabel}
            {model ? ` / ${model}` : ""}
          </TooltipPopup>
        </Tooltip>
        <span className="n-agent-role">
          {role} · {machine}
        </span>
        <button
          type="button"
          className="n-agent-chat nodrag nopan"
          aria-label={chat.label}
          onClick={(event) => {
            event.stopPropagation();
            chat.onClick(event);
          }}
        >
          {chat.icon}
        </button>
      </div>
      {children}
    </div>
  );
}
