import { BaseEdge } from "@xyflow/react";

import type { FloatingCurve } from "./signalEdge";

/**
 * Copied from Foreman Code. The base line of a SignalEdge, reduced to a plain handoff line (pulses
 * and approval styling dropped) plus a mid chevron showing the direction of work requests.
 */
export function SignalEdgeShape({
  id,
  curve,
  interactionWidth = 24,
}: {
  id: string;
  curve: FloatingCurve;
  interactionWidth?: number;
}) {
  const { x, y, angle } = curve.mid;
  return (
    <g className="n-signal-edge" data-kind="execution">
      <BaseEdge
        id={id}
        path={curve.path}
        className="n-signal-edge-base"
        interactionWidth={interactionWidth}
      />
      <path
        className="n-signal-edge-chevron"
        d="M -5,-5 L 3,0 L -5,5"
        transform={`translate(${x} ${y}) rotate(${angle})`}
      />
    </g>
  );
}
