import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { useEnvironmentIdentities } from "../../state/environments";

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
        render={<Button size="sm" variant="outline" aria-label={props.label} title={props.label} />}
      >
        {props.icon}
        {props.badge ? (
          <span className="ml-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground">
            {props.badge}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup width="lg" align="start">
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
