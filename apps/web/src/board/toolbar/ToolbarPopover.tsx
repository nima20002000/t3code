import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import {
  Button,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  useEnvironmentIdentities,
} from "../upstream";

/** Foreman-style toolbar entry: an icon button that opens a popover. */
export function ToolbarPopover(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly badge?: number;
  readonly children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label={props.label} title={props.label} />
        }
      >
        {props.icon}
        {props.badge ? (
          <span className="ml-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-3xs leading-4 text-primary-foreground">
            {props.badge}
          </span>
        ) : null}
      </PopoverTrigger>
      {/* The toolbar sits at the board's right edge, where a right panel or a native browser view can
          begin, so popovers open leftwards and never move to its side. */}
      <PopoverPopup
        width="lg"
        align="end"
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
      >
        <div className="grid gap-3 text-sm">
          <div className="font-medium">{props.label}</div>
          {props.children}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Resolves an environment id to its display label (the "machine"). */
export function useMachineLabel(): (environmentId: EnvironmentId) => string {
  const identities = useEnvironmentIdentities();
  return (environmentId) =>
    identities.find((identity) => identity.environmentId === environmentId)?.label ?? environmentId;
}
