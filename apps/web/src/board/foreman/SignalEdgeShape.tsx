import { BaseEdge } from "@xyflow/react";
import { type CSSProperties } from "react";

import type { EdgeSignal } from "@t3tools/board-core/runView";
import type { FloatingCurve } from "./signalEdge";

/** One fact in flight, delayed relative to its mount. */
export interface EdgePulse {
  readonly key: string;
  readonly signal: EdgeSignal;
  readonly reversed: boolean;
  readonly delay: number;
}

const PULSE_WORDS: Record<EdgeSignal, string> = {
  task: "Request",
  return: "Return",
  error: "Failed",
};

/** Copied from Foreman Code: a comet carrying its word, with a charging wire behind it. The delay
 * is fixed at mount so re-renders never restart it. */
function PulseFlight({ path, pulse }: { path: string; pulse: EdgePulse }) {
  const word = PULSE_WORDS[pulse.signal];
  const width = Math.round(word.length * 7.8 + 24);
  return (
    <g
      className="n-signal-edge-flight"
      data-signal={pulse.signal}
      data-reversed={pulse.reversed || undefined}
      style={{ "--flight-delay": `${Math.round(pulse.delay)}ms` } as CSSProperties}
    >
      <path className="n-signal-edge-charge" d={path} pathLength={1} />
      {[5, 3.4, 2.2].map((radius, index) => (
        <circle
          key={radius}
          className="n-signal-edge-pulse"
          data-tail={index || undefined}
          r={radius}
          style={{ offsetPath: `path('${path}')`, "--tail": `${index * 55}ms` } as CSSProperties}
        />
      ))}
      <g className="n-signal-edge-tag" style={{ offsetPath: `path('${path}')` }}>
        <rect x={-width / 2} y={-31} width={width} height={20} rx={10} />
        <text textAnchor="middle" y={-17}>
          {word}
        </text>
      </g>
    </g>
  );
}

/**
 * Copied from Foreman Code. A handoff line with a mid chevron for the request direction, a lasting
 * trace while the run has work on it, a pending-request count and one pulse per new crossing.
 */
export function SignalEdgeShape({
  id,
  curve,
  signal,
  pending = 0,
  pulses,
  interactionWidth = 24,
}: {
  id: string;
  curve: FloatingCurve;
  signal?: EdgeSignal | undefined;
  pending?: number;
  pulses?: ReadonlyArray<EdgePulse>;
  interactionWidth?: number;
}) {
  const { x, y, angle } = curve.mid;
  const flying = pulses?.at(-1)?.signal;
  return (
    <g className="n-signal-edge" data-kind="execution" data-signal={signal ?? flying}>
      <BaseEdge
        id={id}
        path={curve.path}
        className="n-signal-edge-base"
        interactionWidth={interactionWidth}
      />
      {signal ? <path className="n-signal-edge-trace" d={curve.path} /> : null}
      <path
        className="n-signal-edge-chevron"
        d="M -5,-5 L 3,0 L -5,5"
        transform={`translate(${x} ${y}) rotate(${angle})`}
      />
      {pending > 1 ? (
        <text className="n-signal-edge-count" x={x} y={y - 10} textAnchor="middle">
          {pending}
        </text>
      ) : null}
      {pulses?.map((pulse) => (
        <PulseFlight key={pulse.key} path={curve.path} pulse={pulse} />
      ))}
    </g>
  );
}
