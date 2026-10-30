import { useEffect, useRef, useState } from "react";

/** Keep controls reachable while the pointer crosses a small gap outside their owner. */
export function useHoverControls() {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel the pending timer on unmount.
  useEffect(() => () => clearTimeout(timer.current), []);

  function onPointerEnter() {
    clearTimeout(timer.current);
    setHovered(true);
  }

  function onPointerLeave() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(false), 160);
  }

  function clearHover() {
    clearTimeout(timer.current);
    setHovered(false);
  }

  return { hovered, onPointerEnter, onPointerLeave, clearHover };
}
