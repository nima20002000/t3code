import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { GlobeIcon } from "lucide-react";

import type { BoardNode } from "../boardStore";
import { ToolbarPopover, useMachineLabel } from "./ToolbarPopover";
import { buildThreadRouteParams, useRightPanelStore } from "../upstream";

/**
 * Opens the thread view of a node with t3's built-in Browser panel open (a new browser tab in the
 * node's environment), via the same right-panel store the thread view's browser toggle uses.
 */
export function BrowsersButton(props: { readonly nodes: ReadonlyArray<BoardNode> }) {
  const navigate = useNavigate();
  const machineLabel = useMachineLabel();

  const open = (node: BoardNode) => {
    const ref = scopeThreadRef(node.environmentId, node.threadId);
    useRightPanelStore.getState().openBrowser(ref, null);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };

  return (
    <ToolbarPopover label="Browsers" icon={<GlobeIcon />}>
      {props.nodes.length === 0 ? (
        <p className="text-muted-foreground">Add an agent to the board first.</p>
      ) : (
        <ul className="grid gap-1">
          {props.nodes.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => open(node)}
              >
                <span className="truncate">{node.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {machineLabel(node.environmentId)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </ToolbarPopover>
  );
}
