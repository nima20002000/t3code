import { type EnvironmentId, type ModelSelection, type ProjectId } from "@t3tools/contracts";
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
import { newMessageId, newThreadId } from "../lib/utils";
import {
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { useProjects } from "../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  useEnvironmentProviders,
} from "../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { addNode, appendLog } from "./boardStore";
import { buildAgentFirstPrompt } from "./wakeProtocol";

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";

/**
 * Starts a new agent: creates a full-access thread in the chosen project, sends the role plus the
 * board instructions as its first turn (the same two commands the composer's "implement plan in
 * new thread" uses), then adds a board node bound to it.
 */
export function AddAgentDialog(props: { readonly onClose: () => void }) {
  const environments = useEnvironmentIdentities();
  const connectedIds = useConnectedEnvironmentIds();
  const providersByEnvironment = useEnvironmentProviders();
  const projects = useProjects();
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });

  const connected = environments.filter((environment) =>
    connectedIds.includes(environment.environmentId),
  );
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | "">(
    connected[0]?.environmentId ?? "",
  );
  const [projectChoice, setProjectChoice] = useState<ProjectId | "">("");
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
  const selection: ModelSelection | null =
    modelChoice !== null && modelChoice.environmentId === environmentId
      ? modelChoice.selection
      : resolveDefaultProviderModelSelection(providers, project?.defaultModelSelection);
  const environmentLabel =
    connected.find((environment) => environment.environmentId === environmentId)?.label ?? "";
  const agentName = name.trim() || environmentLabel || "Agent";
  const canSubmit = environmentId !== "" && project !== null && selection !== null && !submitting;

  const submit = async () => {
    if (environmentId === "" || project === null || selection === null) return;
    setSubmitting(true);
    setError(null);
    const threadId = newThreadId();
    const created = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: project.id,
        title: agentName,
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      },
    });
    if (created._tag === "Failure") {
      setSubmitting(false);
      setError("Could not create the thread.");
      return;
    }
    const started = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildAgentFirstPrompt(agentName, role, []),
          attachments: [],
        },
        modelSelection: selection,
        titleSeed: agentName,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    });
    if (started._tag === "Failure") {
      setSubmitting(false);
      setError("The thread was created but its first turn failed to start.");
      return;
    }
    addNode({
      name: agentName,
      environmentId,
      threadId,
      baselined: true,
      awaitingFirstReply: true,
    });
    appendLog("info", `Started agent ${agentName} on ${environmentLabel}.`);
    props.onClose();
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
              Starts a new full-access thread and tells it how the board works.
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
              </label>
              <div className="flex flex-col gap-1">
                Provider and model
                <div>
                  {selection !== null && environmentId !== "" ? (
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
                    <span className="text-muted-foreground">No providers available</span>
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
