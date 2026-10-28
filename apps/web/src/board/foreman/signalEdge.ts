import { useInternalNode, type InternalNode, type Node } from "@xyflow/react";

/**
 * Copied from Foreman Code (board-core/signalEdge.ts), reduced to the rim-to-rim curve between two
 * agent circles. Agent facts, relationship grouping and rim variants were dropped.
 */

/** Default worker diameter. */
export const AGENT_NODE_SIZE = 212;
/** The orchestrator starts half again as big as a worker. */
export const ORCHESTRATOR_NODE_SIZE = AGENT_NODE_SIZE * 1.5;
export const agentNodeSize = (node: { readonly profile: string; readonly size?: number }) =>
  node.size ?? (node.profile === "orchestrator" ? ORCHESTRATOR_NODE_SIZE : AGENT_NODE_SIZE);
const RIM_GAP = 7;

interface Point {
  x: number;
  y: number;
}
interface RimSize {
  width: number;
  height: number;
}
export interface FloatingCurve {
  path: string;
  mid: Point & { angle: number };
}

function dimensions(node: InternalNode<Node>): RimSize {
  return {
    width: node.measured.width ?? node.width ?? AGENT_NODE_SIZE,
    height: node.measured.height ?? node.height ?? AGENT_NODE_SIZE,
  };
}
function center(node: InternalNode<Node>): Point {
  const { width, height } = dimensions(node);
  return {
    x: node.internals.positionAbsolute.x + width / 2,
    y: node.internals.positionAbsolute.y + height / 2,
  };
}
const unit = (x: number, y: number) => {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
};

/** A gently bent curve that leaves and enters each agent anywhere on its rim. */
export function floatingCurve(
  source: Point,
  target: Point,
  bend: number,
  sourceSize: RimSize,
  targetSize: RimSize,
): FloatingCurve {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const control = {
    x: (source.x + target.x) / 2 - (dy / length) * bend,
    y: (source.y + target.y) / 2 + (dx / length) * bend,
  };
  const leave = unit(control.x - source.x, control.y - source.y);
  const enter = unit(target.x - control.x, target.y - control.y);
  const rim = (direction: Point, size: RimSize) =>
    1 / Math.hypot(direction.x / (size.width / 2), direction.y / (size.height / 2)) + RIM_GAP;
  const sourceRadius = rim(leave, sourceSize);
  const targetRadius = rim(enter, targetSize);
  const start = { x: source.x + leave.x * sourceRadius, y: source.y + leave.y * sourceRadius };
  const end = { x: target.x - enter.x * targetRadius, y: target.y - enter.y * targetRadius };
  const mid = {
    x: (start.x + 2 * control.x + end.x) / 4,
    y: (start.y + 2 * control.y + end.y) / 4,
  };
  const angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    path: `M ${round(start.x)},${round(start.y)} Q ${round(control.x)},${round(control.y)} ${round(end.x)},${round(end.y)}`,
    mid: { ...mid, angle },
  };
}

const ALIGNED = 8;
const LEAN = 0.3;
const LEAN_MAX = 90;
const BACK_LEAN = 110;
/**
 * The bend a line needs from where its two ends sit: none when they are aligned, otherwise a curve
 * that leans to the side the target is on. A line that runs back up leans further.
 */
export function lineBend(source: Point, target: Point): number {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const across = vertical ? dx : dy;
  const back = vertical && dy < -ALIGNED;
  if (Math.abs(across) <= ALIGNED && !back) return 0;
  const side = across === 0 ? 1 : Math.sign(across);
  const size = back
    ? Math.max(BACK_LEAN, Math.abs(across) * LEAN)
    : Math.min(LEAN_MAX, Math.abs(across) * LEAN);
  const normal = vertical ? -dy / length : dx / length;
  return size * side * Math.sign(normal);
}

export function useFloatingCurve(source: string, target: string): FloatingCurve | undefined {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to) return undefined;
  const [start, end] = [center(from), center(to)];
  return floatingCurve(start, end, lineBend(start, end), dimensions(from), dimensions(to));
}
