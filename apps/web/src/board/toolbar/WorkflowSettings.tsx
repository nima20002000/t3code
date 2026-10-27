import { ProviderInstanceId, type EnvironmentId, type RuntimeMode } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { SlidersHorizontalIcon } from "lucide-react";

import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useConnectedEnvironmentIds, useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { updateWorkflowSettings, useCurrentWorkflow } from "../boardStore";
import { IconButton } from "./IconButton";

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";

const RUNTIME_MODES: ReadonlyArray<{ readonly value: RuntimeMode; readonly label: string }> = [
  { value: "full-access", label: "Full access" },
  { value: "auto", label: "Auto" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "approval-required", label: "Approval required" },
];

function DefaultModelField(props: { readonly instanceId: string; readonly model: string }) {
  const connectedIds = useConnectedEnvironmentIds();
  const providersByEnvironment = useEnvironmentProviders();
  const environmentId: EnvironmentId | undefined = connectedIds[0];
  const providers =
    (environmentId === undefined ? undefined : providersByEnvironment.get(environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
  const modelOptionsByInstance = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

  if (environmentId === undefined || entries.length === 0) {
    return (
      <span className="text-muted-foreground">
        {props.instanceId} / {props.model} (connect a machine to change)
      </span>
    );
  }
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      activeInstanceId={ProviderInstanceId.make(props.instanceId)}
      model={props.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptionsByInstance}
      onInstanceModelChange={(instanceId, model) => {
        const selection = createModelSelection(instanceId, model);
        updateWorkflowSettings({
          defaultInstanceId: String(selection.instanceId),
          defaultModel: selection.model,
        });
      }}
    />
  );
}

/** Workflow settings: board defaults for Add agent and the per-edge work handoff cap. */
export function WorkflowSettings() {
  const { settings } = useCurrentWorkflow();
  return (
    <Popover>
      <PopoverTrigger render={<IconButton label="Workflow settings" />}>
        <SlidersHorizontalIcon />
      </PopoverTrigger>
      <PopoverPopup width="lg" align="end">
        <div className="grid gap-3 text-sm">
          <div className="font-medium">Workflow settings</div>
          <div className="grid gap-1">
            Default provider and model for Add agent
            <div>
              <DefaultModelField
                instanceId={settings.defaultInstanceId}
                model={settings.defaultModel}
              />
            </div>
          </div>
          <label className="grid gap-1">
            Default runtime mode
            <select
              className={FIELD_CLASS}
              value={settings.runtimeMode}
              onChange={(event) =>
                updateWorkflowSettings({ runtimeMode: event.target.value as RuntimeMode })
              }
            >
              {RUNTIME_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            Max work handoffs per edge per run
            <input
              className={FIELD_CLASS}
              type="number"
              min={1}
              placeholder="Unlimited"
              value={settings.maxHandoffsPerEdge ?? ""}
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10);
                updateWorkflowSettings({
                  maxHandoffsPerEdge: Number.isFinite(value) && value > 0 ? value : null,
                });
              }}
            />
            <span className="text-xs text-muted-foreground">
              Extra requests are denied and the requester is told. Leave empty for no limit.
            </span>
          </label>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
