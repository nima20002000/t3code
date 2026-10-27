import type { EnvironmentId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import type { BoardWorkspace } from "@t3tools/board-core/http";
import { addWorkspaceFolder, removeWorkspaceFolder } from "./boardStore";
import { IconButton } from "./toolbar/IconButton";
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
  Input,
} from "./upstream";

/** One text field: used to name or rename a workspace or workflow. */
export function NameDialog(props: {
  readonly title: string;
  readonly label: string;
  readonly initial: string;
  readonly action: string;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(props.initial);
  const trimmed = name.trim();
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed) return;
            props.onSubmit(trimmed);
            props.onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label={props.label}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed}>
              {props.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function ConfirmDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              props.onConfirm();
              props.onClose();
            }}
          >
            {props.action}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The workspace's folder on each machine (machine name and path), with add and remove. */
export function WorkspaceSettingsDialog(props: {
  readonly workspace: BoardWorkspace;
  readonly onClose: () => void;
}) {
  const { workspace } = props;
  const machines = useBoardMachines();
  const labelOf = (environmentId: EnvironmentId) =>
    machines.find((machine) => machine.environmentId === environmentId)?.label ?? "Unknown machine";
  const free = machines.filter(
    (machine) =>
      !workspace.folders.some((folder) => folder.environmentId === machine.environmentId),
  );
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | "">("");
  const [path, setPath] = useState("");
  const chosen = free.find((machine) => machine.environmentId === environmentId) ?? free[0];
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{workspace.name} settings</DialogTitle>
          <DialogDescription>
            Each machine that runs this workspace's agents works in its own folder.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3 text-sm">
            {workspace.folders.length === 0 ? (
              <p className="text-muted-foreground">
                No folders yet. One is created on a machine when an agent first runs there.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {workspace.folders.map((folder) => (
                  <li
                    key={folder.environmentId}
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5"
                  >
                    <span className="grid min-w-0">
                      <strong className="truncate">{labelOf(folder.environmentId)}</strong>
                      <small className="truncate text-muted-foreground">{folder.path}</small>
                    </span>
                    <IconButton
                      label={`Remove folder on ${labelOf(folder.environmentId)}`}
                      onClick={() => removeWorkspaceFolder(workspace.id, folder.environmentId)}
                    >
                      <XIcon />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            {chosen ? (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  addWorkspaceFolder(workspace.id, chosen.environmentId, path);
                  setPath("");
                }}
              >
                <select
                  aria-label="Machine"
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  value={chosen.environmentId}
                  onChange={(event) => setEnvironmentId(event.target.value as EnvironmentId)}
                >
                  {free.map((machine) => (
                    <option key={machine.environmentId} value={machine.environmentId}>
                      {machine.label}
                    </option>
                  ))}
                </select>
                <Input
                  className="min-w-40 flex-1"
                  aria-label="Folder path"
                  placeholder="Path (default: ~/t3-workspaces/...)"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                />
                <Button type="submit" size="sm">
                  Add folder
                </Button>
              </form>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
