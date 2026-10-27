import { type EnvironmentId, type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useRef, useState } from "react";
import * as Schema from "effect/Schema";

import { createNode, nextNodePosition, useBoardWorkspaces, useCurrentWorkflow } from "./boardStore";
import { useBoardMachines } from "./useBoardMachines";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  EMPTY_SERVER_PROVIDERS,
  Input,
  ProviderModelPicker,
  Textarea,
  deriveProviderInstanceEntries,
  randomUUID,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
  useEnvironmentProviders,
} from "./upstream";

const isProviderInstanceId = Schema.is(ProviderInstanceId);

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";

export function AddAgentDialog(props: { readonly onClose: () => void }) {
  const connected = useBoardMachines();
  const providersByEnvironment = useEnvironmentProviders();
  const workspace = useBoardWorkspaces().find((item) => item.id === workflow.workspaceId);
  const workflow = useCurrentWorkflow();
  const { id: workflowId, settings } = workflow;
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | "">(
    connected[0]?.environmentId ?? "",
  );
  const [manualProvider, setManualProvider] = useState(settings.defaultInstanceId);
  const [manualModel, setManualModel] = useState(settings.defaultModel);
  const [modelChoice, setModelChoice] = useState<{
    readonly environmentId: EnvironmentId;
    readonly selection: ModelSelection;
  } | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingId = useRef<string | null>(null);

  const folder = workspace?.folders.find((item) => item.environmentId === environmentId);
  const hasOrchestrator = workflow.nodes.some((node) => node.profile === "orchestrator");
  const [chosenProfile, setChosenProfile] = useState<"worker" | "orchestrator">("orchestrator");
  const profile = hasOrchestrator ? "worker" : chosenProfile;
  const providers =
    (environmentId === "" ? undefined : providersByEnvironment.get(environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
  const modelOptionsByInstance = new Map(entries.map((entry) => [entry.instanceId, entry.models]));
  const defaultSelection = createModelSelection(
    ProviderInstanceId.make(settings.defaultInstanceId),
    settings.defaultModel,
  );
  const manualInstanceId = manualProvider.trim();
  const selection: ModelSelection | null =
    entries.length === 0
      ? isProviderInstanceId(manualInstanceId) && manualModel.trim()
        ? createModelSelection(manualInstanceId, manualModel.trim())
        : null
      : modelChoice !== null && modelChoice.environmentId === environmentId
        ? modelChoice.selection
        : (resolveDefaultProviderModelSelection(providers, defaultSelection) ?? defaultSelection);
  const environmentLabel =
    connected.find((environment) => environment.environmentId === environmentId)?.label ?? "";
  const agentName = name.trim() || environmentLabel || "Agent";
  const canSubmit = environmentId !== "" && selection !== null && !submitting;

  const submit = async () => {
    if (environmentId === "" || selection === null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const id = pendingId.current ?? randomUUID();
      pendingId.current = id;
      await createNode(workflowId, {
        id,
        name: agentName,
        profile,
        environmentId,
        modelSelection: selection,
        ...(role.trim() ? { prompt: role } : {}),
        ...nextNodePosition(workflow),
      });
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add agent</DialogTitle>
            <DialogDescription>
              Each run starts a fresh {settings.runtimeMode} thread for this agent in the workspace
              folder.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3 text-sm">
              <label className="flex flex-col gap-1">
                Profile
                <select
                  className={FIELD_CLASS}
                  value={profile}
                  onChange={(event) =>
                    setChosenProfile(event.target.value as "worker" | "orchestrator")
                  }
                >
                  <option value="worker">Worker</option>
                  <option value="orchestrator" disabled={hasOrchestrator}>
                    Orchestrator{hasOrchestrator ? " (this workflow already has one)" : ""}
                  </option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Machine
                <select
                  className={FIELD_CLASS}
                  value={environmentId}
                  onChange={(event) => {
                    setEnvironmentId(event.target.value as EnvironmentId | "");
                  }}
                >
                  <option value="">Select...</option>
                  {connected.map((environment) => (
                    <option key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1">
                Folder
                <p className="text-muted-foreground">
                  {folder
                    ? folder.path
                    : `${workspace?.name ?? "The workspace"} gets a folder on this machine when the agent first runs.`}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                Provider and model
                <div>
                  {selection !== null && environmentId !== "" && entries.length > 0 ? (
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={selection.instanceId}
                      model={selection.model}
                      lockedProvider={null}
                      instanceEntries={entries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      onInstanceModelChange={(instanceId, model) =>
                        setModelChoice({
                          environmentId,
                          selection: createModelSelection(instanceId, model),
                        })
                      }
                    />
                  ) : (
                    <div className="grid gap-2">
                      <label className="grid gap-1">
                        Provider ID
                        <Input
                          value={manualProvider}
                          onChange={(event) => setManualProvider(event.target.value)}
                        />
                      </label>
                      <label className="grid gap-1">
                        Model
                        <Input
                          value={manualModel}
                          onChange={(event) => setManualModel(event.target.value)}
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
              <label className="flex flex-col gap-1">
                Node name
                <Input
                  placeholder={environmentLabel || "Agent"}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                First prompt / role (optional)
                <Textarea
                  placeholder="You are the backend engineer..."
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                />
              </label>
              {error ? <p className="text-destructive-foreground">{error}</p> : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? "Starting..." : "Start agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
