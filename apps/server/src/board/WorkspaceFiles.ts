// @effect-diagnostics nodeBuiltinImport:off -- staged upload names only need a random id.
import * as NodeCrypto from "node:crypto";
import {
  BoardInvalidRequestError,
  BoardNotFoundError,
  type Workspace,
  type BoardFileMachine,
  type BoardWorkspaceFile,
} from "@t3tools/board-core";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as BoardStore from "./BoardStore.ts";
import * as FileShipper from "./FileShipper.ts";
import * as SharedFileStore from "./SharedFileStore.ts";
import * as TaskEngine from "./TaskEngine.ts";
import { ServerConfig, ServerEnvironment, forkParked } from "./upstream.ts";

/**
 * A workspace's shared files. The hub keeps the only real copy; a background worker copies each
 * file to every machine with an agent in the workspace (and the hub's own workspace folder), and
 * sends a machine only the files whose version it does not have yet.
 */
export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  {
    readonly add: <E, R>(
      workspaceId: string,
      name: string,
      body: Stream.Stream<Uint8Array, E, R>,
    ) => Effect.Effect<BoardWorkspaceFile, FileError, R>;
    readonly remove: (workspaceId: string, name: string) => Effect.Effect<void, FileError>;
  }
>()("t3/board/WorkspaceFiles") {}

type FileError = SharedFileStore.FileError;
const internal = SharedFileStore.keepBoardErrors;

/** Machines copying at once; each copies its files one by one. */
const MACHINES_AT_ONCE = 3;
const RETRY_EVERY = "1 minute";

const failureMessage = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    if ("_tag" in cause && cause._tag === "NodeDriverError")
      return "The machine is offline or can't be reached.";
    if ("message" in cause && typeof cause.message === "string") return cause.message;
  }
  return "Could not copy the files.";
};

const sameMachines = (a: ReadonlyArray<BoardFileMachine>, b: ReadonlyArray<BoardFileMachine>) =>
  a.length === b.length &&
  a.every(
    (machine, index) =>
      machine.environmentId === b[index]!.environmentId &&
      machine.status === b[index]!.status &&
      machine.error === b[index]!.error,
  );

export const make = Effect.fn("WorkspaceFiles.make")(function* (options: {
  readonly hubEnvironmentId: EnvironmentId;
  /** The hub's folder for shared files; each workspace gets its own subfolder. */
  readonly root: string;
}) {
  const store = yield* BoardStore.BoardStore;
  const engine = yield* TaskEngine.TaskEngine;
  const shipper = yield* FileShipper.FileShipper;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const hubWrites = yield* Semaphore.make(1);
  const copying = yield* Semaphore.make(MACHINES_AT_ONCE);

  // Workspace ids are free text, so they are escaped into one safe folder name.
  const folderOf = (workspaceId: string) =>
    path.join(options.root, `w-${encodeURIComponent(workspaceId)}`);
  /** One stored version of a workspace file, named by its content's sha256. */
  const blobOf = (workspaceId: string, sha256: string) => path.join(folderOf(workspaceId), sha256);

  /** The hub first, then every machine with an agent in one of the workspace's workflows. */
  const machinesOf = Effect.fn("WorkspaceFiles.machinesOf")(function* (workspaceId: string) {
    const workflows = (yield* store.listWorkflows()).filter(
      (workflow) => workflow.workspaceId === workspaceId,
    );
    return [
      ...new Set<EnvironmentId>([
        options.hubEnvironmentId,
        ...workflows.flatMap((workflow) => workflow.nodes.map((node) => node.environmentId)),
      ]),
    ];
  });

  const outstanding = (
    files: ReadonlyArray<BoardWorkspaceFile>,
    copies: ReadonlyMap<string, string>,
  ) => ({
    uploads: files.filter((file) => copies.get(file.name) !== file.sha256),
    deletes: [...copies.keys()].filter((name) => !files.some((file) => file.name === name)),
  });

  /** What the machine's current workspace folder holds; a new or replaced folder holds nothing. */
  const copiesOn = Effect.fn("WorkspaceFiles.copiesOn")(function* (
    workspace: Workspace,
    environmentId: EnvironmentId,
  ) {
    const folder = workspace.folders.find((entry) => entry.environmentId === environmentId);
    return folder
      ? yield* store.listFileCopies(workspace.id, environmentId, folder.projectId)
      : new Map<string, string>();
  });

  /**
   * Recomputes each machine's state and tells clients when it or the file list changed.
   * `outcome` is the result of the copy just made to one machine: its error, or none.
   */
  const publish = Effect.fn("WorkspaceFiles.publish")(function* (
    workspaceId: string,
    options?: {
      readonly filesChanged?: boolean;
      readonly outcome?: { readonly environmentId: EnvironmentId; readonly error?: string };
    },
  ) {
    yield* store.transaction(
      Effect.gen(function* () {
        const workspace = yield* store.getWorkspace(workspaceId);
        if (!workspace) return;
        const files = yield* store.listWorkspaceFiles(workspaceId);
        const previous = yield* store.listFileMachines(workspaceId);
        const machines: Array<BoardFileMachine> = [];
        for (const environmentId of yield* machinesOf(workspaceId)) {
          const { uploads, deletes } = outstanding(
            files,
            yield* copiesOn(workspace, environmentId),
          );
          const error =
            options?.outcome?.environmentId === environmentId
              ? options.outcome.error
              : previous.find((machine) => machine.environmentId === environmentId)?.error;
          machines.push(
            uploads.length === 0 && deletes.length === 0
              ? { environmentId, status: "synced" }
              : error === undefined
                ? { environmentId, status: "pending" }
                : { environmentId, status: "failed", error },
          );
        }
        if (!options?.filesChanged && sameMachines(previous, machines)) return;
        yield* store.putFileMachines(workspaceId, machines);
        yield* store.appendEvent({ kind: "workspace.files", workspaceId, files, machines });
      }),
    );
  });

  const copyTo = Effect.fn("WorkspaceFiles.copyTo")(function* (
    workspaceId: string,
    environmentId: EnvironmentId,
  ) {
    const workspace = yield* store.getWorkspace(workspaceId);
    if (!workspace) return;
    const files = yield* store.listWorkspaceFiles(workspaceId);
    const before = outstanding(files, yield* copiesOn(workspace, environmentId));
    if (before.uploads.length === 0 && before.deletes.length === 0) return;
    const { folder } = yield* engine.workspaceFolder(workspaceId, environmentId);
    const copies = yield* store.listFileCopies(workspaceId, environmentId, folder.projectId);
    const { uploads, deletes } = outstanding(files, copies);
    const target = { environmentId, projectId: folder.projectId };
    // Deletes first: on a case-insensitive disk, "Notes.txt" and a newer "notes.txt" are one file.
    for (const name of deletes) {
      yield* shipper.remove({ ...target, name });
      yield* store.deleteFileCopy(workspaceId, environmentId, name);
    }
    for (const file of uploads) {
      const source = blobOf(workspaceId, file.sha256);
      // Replaced or removed on the hub since the list was read; the next pass sends the change.
      if (!(yield* fs.exists(source))) continue;
      // Unknown until the machine answers: a lost answer leaves it to be sent (or deleted) again.
      yield* store.putFileCopy(workspaceId, environmentId, folder.projectId, file.name, "");
      const sha256 = yield* shipper.put({ ...target, name: file.name, source });
      yield* store.putFileCopy(workspaceId, environmentId, folder.projectId, file.name, sha256);
    }
  });

  const syncWorkspace = Effect.fn("WorkspaceFiles.syncWorkspace")(function* (workspaceId: string) {
    if (!(yield* store.getWorkspace(workspaceId))) {
      yield* fs.remove(folderOf(workspaceId), { recursive: true, force: true });
      return;
    }
    // Shows a machine leaving or joining the workspace before any copy starts.
    yield* publish(workspaceId);
    yield* Effect.forEach(
      yield* machinesOf(workspaceId),
      (environmentId) =>
        copying.withPermits(1)(
          Effect.gen(function* () {
            // The machine may have left the workspace while it waited for its turn.
            if (!(yield* machinesOf(workspaceId)).includes(environmentId)) return;
            yield* copyTo(workspaceId, environmentId).pipe(
              Effect.matchEffect({
                onSuccess: () => publish(workspaceId, { outcome: { environmentId } }),
                onFailure: (cause) =>
                  cause._tag === "SqlError"
                    ? Effect.fail(cause)
                    : publish(workspaceId, {
                        outcome: { environmentId, error: failureMessage(cause) },
                      }),
              }),
            );
          }),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  // One pass per workspace at a time; a wake during a pass runs one more pass after it.
  const passes = new Map<string, "running" | "again">();
  const wake = (workspaceId: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (passes.has(workspaceId)) {
        passes.set(workspaceId, "again");
        return Effect.void;
      }
      passes.set(workspaceId, "running");
      const pass: Effect.Effect<void> = syncWorkspace(workspaceId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not sync the workspace's shared files", { workspaceId, cause }),
        ),
        Effect.andThen(
          Effect.suspend(() => {
            if (passes.get(workspaceId) === "again") {
              passes.set(workspaceId, "running");
              return pass;
            }
            passes.delete(workspaceId);
            return Effect.void;
          }),
        ),
      );
      return pass.pipe(Effect.forkIn(scope), Effect.asVoid);
    });
  const wakeAll = store
    .listWorkspaces()
    .pipe(
      Effect.flatMap((workspaces) =>
        Effect.forEach(workspaces, (workspace) => wake(workspace.id), { discard: true }),
      ),
    );

  /** Drops a version no file of the workspace uses any more; a leftover is only wasted space. */
  const dropUnused = (workspaceId: string, sha256: string | undefined) =>
    sha256 === undefined
      ? Effect.void
      : hubWrites.withPermits(1)(
          // Under the lock, so an upload of the same content cannot claim it in between.
          store.listWorkspaceFiles(workspaceId).pipe(
            Effect.flatMap((files) =>
              files.some((file) => file.sha256 === sha256)
                ? Effect.void
                : fs.remove(blobOf(workspaceId, sha256), { force: true }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not remove an unused shared file", { workspaceId, cause }),
            ),
          ),
        );

  const add = Effect.fn("WorkspaceFiles.add")(function* <E, R>(
    workspaceId: string,
    name: string,
    body: Stream.Stream<Uint8Array, E, R>,
  ) {
    yield* SharedFileStore.checkName(name);
    if (!(yield* store.getWorkspace(workspaceId)))
      return yield* new BoardNotFoundError({ message: "Workspace not found." });
    // Streamed aside first, so a slow upload never holds the lock and a failed one changes nothing.
    const incoming = path.join(options.root, ".incoming");
    const staged = NodeCrypto.randomUUID();
    const written = yield* SharedFileStore.writeStreamed(incoming, staged, body).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const { file, replaced } = yield* hubWrites
      .withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* store.getWorkspace(workspaceId)))
            return yield* new BoardNotFoundError({ message: "Workspace not found." });
          const existing = yield* store.listWorkspaceFiles(workspaceId);
          // Windows and macOS folders would keep only one of two names that differ by case.
          const clash = existing.find(
            (entry) => entry.name !== name && entry.name.toLowerCase() === name.toLowerCase(),
          );
          if (clash)
            return yield* new BoardInvalidRequestError({
              message: `“${clash.name}” is already shared; names may not differ only by case.`,
            });
          // Each version is kept under its hash, so the current one stays intact until the
          // database points at the new one.
          yield* fs.makeDirectory(folderOf(workspaceId), { recursive: true });
          yield* fs.rename(path.join(incoming, staged), blobOf(workspaceId, written.sha256));
          const file: BoardWorkspaceFile = {
            name,
            size: written.size,
            sha256: written.sha256,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* store.transaction(store.putWorkspaceFile(workspaceId, file));
          yield* publish(workspaceId, { filesChanged: true });
          return { file, replaced: existing.find((entry) => entry.name === name)?.sha256 };
        }),
      )
      .pipe(
        Effect.ensuring(
          fs.remove(path.join(incoming, staged), { force: true }).pipe(Effect.ignore),
        ),
      );
    yield* wake(workspaceId);
    if (replaced !== file.sha256) yield* dropUnused(workspaceId, replaced);
    return file;
  }, internal("Could not add the file."));

  const remove = Effect.fn("WorkspaceFiles.remove")(function* (workspaceId: string, name: string) {
    yield* SharedFileStore.checkName(name);
    const removed = yield* hubWrites.withPermits(1)(
      Effect.gen(function* () {
        const file = (yield* store.listWorkspaceFiles(workspaceId)).find(
          (entry) => entry.name === name,
        );
        if (!file) return yield* new BoardNotFoundError({ message: "File not found." });
        yield* store.transaction(store.deleteWorkspaceFile(workspaceId, name));
        yield* publish(workspaceId, { filesChanged: true });
        return file;
      }),
    );
    yield* wake(workspaceId);
    yield* dropUnused(workspaceId, removed.sha256);
  }, internal("Could not remove the file."));

  // Follows the board: a saved workflow can add or drop a machine, a machine coming back online
  // can take what it missed, and a deleted workspace's files leave the hub.
  const { sequence } = yield* store.snapshot();
  yield* forkParked(
    Effect.gen(function* () {
      yield* wakeAll;
      yield* store.events(sequence).pipe(
        Stream.runForEach((event) => {
          switch (event.kind) {
            case "workflow.upserted":
              return wake(event.workflow.workspaceId);
            case "workspace.upserted":
              return wake(event.workspace.id);
            case "workspace.deleted":
              return wake(event.workspaceId);
            case "peer.upserted":
              return event.peer.status === "connected" ? wakeAll : Effect.void;
            default:
              return Effect.void;
          }
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Shared file sync stopped following the board", { cause }),
      ),
    ),
  );
  // Machines that were offline or failed get another try.
  yield* forkParked(
    store.listWorkspaces().pipe(
      Effect.flatMap((workspaces) =>
        Effect.forEach(
          workspaces,
          (workspace) =>
            store
              .listFileMachines(workspace.id)
              .pipe(
                Effect.flatMap((machines) =>
                  machines.some((machine) => machine.status !== "synced")
                    ? wake(workspace.id)
                    : Effect.void,
                ),
              ),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check shared file sync", { cause }),
      ),
      Effect.delay(RETRY_EVERY),
      Effect.forever,
    ),
  );

  return WorkspaceFiles.of({ add, remove });
});

export const layer = Layer.effect(
  WorkspaceFiles,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const path = yield* Path.Path;
    return yield* make({
      hubEnvironmentId: yield* environment.getEnvironmentId,
      root: path.join(config.stateDir, "board-files"),
    });
  }),
).pipe(Layer.provide(FileShipper.layer));
