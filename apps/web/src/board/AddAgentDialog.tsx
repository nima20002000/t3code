import {
  type EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useRef, useState } from "react";
import * as Schema from "effect/Schema";

import { createNode, nextNodePosition, useCurrentWorkflow } from "./boardStore";
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
  newThreadId,
  randomUUID,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
  useEnvironmentProviders,
  useProjects,
} from "./upstream";

const isProviderInstanceId = Schema.is(ProviderInstanceId);

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";

export function AddAgentDialog(props: { readonly onClose: () => void }) {
  const connected = useBoardMachines();
  const providersByEnvironment = useEnvironmentProviders();
  const projects = useProjects();
  const workflow = useCurrentWorkflow();
  const { id: workflowId, settings } = workflow;
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | "">(
    connected[0]?.environmentId ?? "",
  );
  const [projectChoice, setProjectChoice] = useState<ProjectId | "">("");
  const [manualProject, setManualProject] = useState("");
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
  const pendingSubmission = useRef<{
    key: string;
    ids: { id: string; threadId: ReturnType<typeof newThreadId> };
  } | null>(null);

  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const project =
    environmentProjects.find((candidate) => candidate.id === projectChoice) ??
    environmentProjects[0] ??
    null;
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
  const projectId =
    project?.id ?? (manualProject.trim() ? ProjectId.make(manualProject.trim()) : null);
  const canSubmit = environmentId !== "" && projectId !== null && selection !== null && !submitting;

  const submit = async () => {
    if (environmentId === "" || projectId === null || selection === null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const input = {
        kind: "launch" as const,
        name: agentName,
        environmentId,
        projectId,
        modelSelection: selection,
        runtimeMode: settings.runtimeMode,
        interactionMode: "default" as const,
        workspaceStrategy: { type: "root" as const },
        role,
      };
      const key = JSON.stringify([workflowId, input]);
      const ids =
        pendingSubmission.current?.key === key
          ? pendingSubmission.current.ids
          : { id: randomUUID(), threadId: newThreadId() };
      pendingSubmission.current = { key, ids };
      await createNode(workflowId, { ...input, ...ids, ...nextNodePosition(workflow) });
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
              Starts a new {settings.runtimeMode} thread and tells it how the board works.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3 text-sm">
              <label className="flex flex-col gap-1">
                Machine
                <select
                  className={FIELD_CLASS}
                  value={environmentId}
                  onChange={(event) => {
                    setEnvironmentId(event.target.value as EnvironmentId | "");
                    setProjectChoice("");
                    setManualProject("");
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
              <label className="flex flex-col gap-1">
                Project
                {environmentProjects.length ? (
                  <select
                    className={FIELD_CLASS}
                    value={project?.id ?? ""}
                    onChange={(event) => setProjectChoice(event.target.value as ProjectId)}
                  >
                    {environmentProjects.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    aria-label="Project ID"
                    placeholder="Project ID on this machine"
                    value={manualProject}
                    onChange={(event) => setManualProject(event.target.value)}
                  />
                )}
              </label>
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
