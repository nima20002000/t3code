import {
  type EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useState } from "react";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { newThreadId, randomUUID } from "../lib/utils";
import {
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { useProjects } from "../state/entities";
import { useEnvironmentProviders } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { createNode, nextNodePosition, useCurrentWorkflow } from "./boardStore";
import { useBoardMachines } from "./useBoardMachines";

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
  const [modelChoice, setModelChoice] = useState<{
    readonly environmentId: EnvironmentId;
    readonly selection: ModelSelection;
  } | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const selection: ModelSelection | null =
    modelChoice !== null && modelChoice.environmentId === environmentId
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
      await createNode(workflowId, {
        kind: "launch",
        id: randomUUID(),
        name: agentName,
        environmentId,
        projectId,
        threadId: newThreadId(),
        modelSelection: selection,
        runtimeMode: settings.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        role,
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
                    <span className="text-muted-foreground">
                      {settings.defaultInstanceId} / {settings.defaultModel} (workflow default)
                    </span>
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
