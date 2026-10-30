import { sharedFileNameProblem, SHARED_FILES_FOLDER } from "@t3tools/board-core/sharedFiles";
import type { BoardFileMachine } from "@t3tools/board-core/http";
import { FolderIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useState, type DragEvent } from "react";

import { runBoardMutation, uploadWorkspaceFile } from "../boardApi";
import { useBoardPeers, useBoardWorkspaces, useWorkspaceFiles } from "../boardStore";
import { ToolbarPopover, useMachineLabel } from "./ToolbarPopover";
import { Button, randomUUID } from "../upstream";

const errorText = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String(cause.message)
    : String(cause);

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const STATUS_TEXT: Record<BoardFileMachine["status"], string> = {
  synced: "up to date",
  pending: "copying…",
  failed: "not copied",
};

/**
 * The workspace's shared files: kept on the hub, copied to every machine with an agent in the
 * workspace. Files dropped on the button or into the panel are added.
 */
export function FilesButton(props: { readonly workspaceId: string }) {
  const workspace = useBoardWorkspaces().find((entry) => entry.id === props.workspaceId);
  const { files, machines } = useWorkspaceFiles(props.workspaceId);
  const identityLabel = useMachineLabel();
  const peers = useBoardPeers();
  const machineLabel = (environmentId: BoardFileMachine["environmentId"]) =>
    peers.find((peer) => peer.environmentId === environmentId)?.name ??
    identityLabel(environmentId);
  const [uploading, setUploading] = useState<
    ReadonlyArray<{ readonly id: string; readonly name: string }>
  >([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (picked: ReadonlyArray<File>) => {
    setError(null);
    const problems = picked.flatMap((file) => {
      const problem = sharedFileNameProblem(file.name);
      return problem ? [`${file.name}: ${problem}`] : [];
    });
    const valid = picked
      .filter((file) => sharedFileNameProblem(file.name) === undefined)
      .map((file) => ({ id: randomUUID(), name: file.name, file }));
    setUploading((current) => [...current, ...valid]);
    const failures = await Promise.all(
      valid.map((entry) =>
        uploadWorkspaceFile(props.workspaceId, entry.file)
          .then(
            () => null,
            (cause: unknown) => `${entry.name}: ${errorText(cause)}`,
          )
          .finally(() =>
            setUploading((current) => current.filter((upload) => upload.id !== entry.id)),
          ),
      ),
    );
    const messages = [...problems, ...failures.filter((entry) => entry !== null)];
    if (messages.length > 0) setError(messages.join("\n"));
  };
  const remove = async (name: string) => {
    setError(null);
    try {
      await runBoardMutation((client) =>
        client.deleteWorkspaceFile({
          headers: {},
          params: { workspaceId: props.workspaceId, name },
        }),
      );
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const dropping = {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(false);
      // Folders arrive as entries with no file behind them; only plain files are shared.
      const picked = [...event.dataTransfer.items]
        .filter((item) => item.kind === "file" && item.webkitGetAsEntry()?.isFile !== false)
        .flatMap((item) => item.getAsFile() ?? []);
      void add(picked);
    },
  };

  return (
    // React events bubble through the portal, so drops in the open panel land here too.
    <div className="contents" {...dropping}>
      <ToolbarPopover label="Files" icon={<FolderIcon />}>
        <p className="text-xs text-muted-foreground">
          Shared with every agent in {workspace ? `“${workspace.name}”` : "this workspace"}. Each
          machine with an agent gets a copy in {SHARED_FILES_FOLDER}/ of its workspace folder.
        </p>
        <label
          className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground ${
            dragging ? "border-primary bg-accent" : "border-border"
          }`}
        >
          <UploadIcon className="size-4" />
          Drop files here, or click to choose
          <input
            type="file"
            multiple
            className="sr-only"
            onChange={(event) => {
              const picked = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              void add(picked);
            }}
          />
        </label>
        {error ? <p className="whitespace-pre-line text-xs text-destructive">{error}</p> : null}
        {files.length === 0 && uploading.length === 0 ? (
          <p className="text-muted-foreground">No shared files yet.</p>
        ) : (
          <ul className="grid max-h-64 gap-0.5 overflow-y-auto" aria-label="Shared files">
            {uploading.map(({ id, name }) => (
              <li
                key={id}
                className="flex items-center justify-between gap-2 px-2 py-1 text-muted-foreground"
              >
                <span className="truncate">{name}</span>
                <span className="shrink-0 text-xs">uploading…</span>
              </li>
            ))}
            {files.map((file) => (
              <li
                key={file.name}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-accent"
              >
                <span className="min-w-0 truncate">{file.name}</span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {formatSize(file.size)}
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => void remove(file.name)}
                  >
                    <Trash2Icon />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 || machines.some((machine) => machine.status !== "synced") ? (
          <ul className="grid gap-0.5 text-xs" aria-label="Copies on machines">
            {machines.map((machine) => (
              <li key={machine.environmentId} className="flex justify-between gap-2">
                <span className="max-w-1/2 shrink-0 truncate">
                  {machineLabel(machine.environmentId)}
                </span>
                <span
                  className={`text-right ${machine.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {STATUS_TEXT[machine.status]}
                  {machine.status === "failed" && machine.error ? `: ${machine.error}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </ToolbarPopover>
    </div>
  );
}
