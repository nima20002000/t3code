import {
  type EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useRef, useState, type FormEvent } from "react";
import * as Schema from "effect/Schema";

import {
  configureNode,
  createNode,
  nextNodePosition,
  useBoardWorkspaces,
  useCurrentWorkflow,
  type BoardNode,
} from "./boardStore";
import { pairConnectedMachine } from "./boardApi";
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
  useEnvironmentProviders,
} from "./upstream";

const isProviderInstanceId = Schema.is(ProviderInstanceId);

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";

const ACCESS_MODES: ReadonlyArray<{ readonly value: RuntimeMode; readonly label: string }> = [
  { value: "full-access", label: "Full access" },
  { value: "auto", label: "Auto" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "approval-required", label: "Approval required" },
];

/** Adds an agent, or with `node` edits one: profile, machine, model, access, name and role. */
export function AgentDialog(props: {
  readonly node?: BoardNode;
  readonly onClose: () => void;
  readonly onRemove?: () => void;
  readonly onSendInstructions?: () => void;
}) {
  const { node } = props;
  const connected = useBoardMachines();
  const providersByEnvironment = useEnvironmentProviders();
  const workflow = useCurrentWorkflow();
  const workspace = useBoardWorkspaces().find((item) => item.id === workflow.workspaceId);
  const { id: workflowId, settings } = workflow;
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | "">(
    node?.environmentId ?? connected[0]?.environmentId ?? "",
  );
  const [manualProvider, setManualProvider] = useState(settings.defaultInstanceId);
  const [manualModel, setManualModel] = useState(settings.defaultModel);
  const [modelChoice, setModelChoice] = useState<{
    readonly environmentId: EnvironmentId;
    readonly selection: ModelSelection;
  } | null>(node ? { environmentId: node.environmentId, selection: node.modelSelection } : null);
  const [name, setName] = useState(node?.name ?? "");
  const [role, setRole] = useState(node?.prompt ?? "");
  const [access, setAccess] = useState<RuntimeMode>(node?.runtimeMode ?? "full-access");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingId = useRef<string | null>(null);

  const folder = workspace?.folders.find((item) => item.environmentId === environmentId);
  const hasOrchestrator = workflow.nodes.some(
    (other) => other.id !== node?.id && other.profile === "orchestrator",
  );
  const [chosenProfile, setChosenProfile] = useState<"worker" | "orchestrator">(
    node?.profile ?? "orchestrator",
  );
  const profile = hasOrchestrator ? "worker" : chosenProfile;
  const providers =
    (environmentId === "" ? undefined : providersByEnvironment.get(environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = deriveProviderInstanceEntries(providers);
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
      const machine = connected.find((item) => item.environmentId === environmentId);
      if (machine && !machine.paired) await pairConnectedMachine(environmentId, machine.label);
      if (node) {
        await configureNode(node.id, {
          name: agentName,
          profile,
          environmentId,
          modelSelection: selection,
          runtimeMode: access,
          prompt: role,
        });
        props.onClose();
        return;
      }
      const id = pendingId.current ?? randomUUID();
      pendingId.current = id;
      await createNode(workflowId, {
        id,
        name: agentName,
        profile,
        environmentId,
        modelSelection: selection,
        runtimeMode: access,
        ...(role.trim() ? { prompt: role } : {}),
        ...nextNodePosition(workflow),
      });
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };
  const fields = (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Profile
        <select
          className={FIELD_CLASS}
          value={profile}
          onChange={(event) => setChosenProfile(event.target.value as "worker" | "orchestrator")}
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
              {environment.paired ? "" : " (pairs when added)"}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-col gap-1">
        Folder
        <p className="text-muted-foreground">
          {folder
            ? folder.path || "The machine's existing t3 project"
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
        Access
        <select
          className={FIELD_CLASS}
          value={access}
          onChange={(event) => setAccess(event.target.value as RuntimeMode)}
        >
          {ACCESS_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
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
  );
  const actions = (
    <>
      {props.onRemove ? (
        <Button
          type="button"
          variant="destructive-outline"
          className="sm:mr-auto"
          onClick={props.onRemove}
        >
          Remove
        </Button>
      ) : null}
      {props.onSendInstructions ? (
        <Button type="button" variant="outline" onClick={props.onSendInstructions}>
          Send board instructions
        </Button>
      ) : null}
      <Button type="button" variant="outline" onClick={props.onClose}>
        Cancel
      </Button>
      <Button type="submit" disabled={!canSubmit}>
        {node ? (submitting ? "Saving..." : "Save") : submitting ? "Adding..." : "Add agent"}
      </Button>
    </>
  );

  // Editing fills the agent's settings window on the board; adding stays a modal dialog.
  if (node)
    return (
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{fields}</div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t p-3">{actions}</div>
      </form>
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form className="flex min-h-0 flex-col" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add agent</DialogTitle>
            <DialogDescription>
              Each run starts a fresh thread for this agent in the workspace folder.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>{fields}</DialogPanel>
          <DialogFooter>{actions}</DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
