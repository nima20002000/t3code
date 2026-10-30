// @effect-diagnostics nodeBuiltinImport:off -- a streaming sha256 has no Effect equivalent.
import * as NodeCrypto from "node:crypto";
import {
  BoardInternalError,
  BoardInvalidRequestError,
  BoardNotFoundError,
  SHARED_FILES_FOLDER,
  sharedFileNameProblem,
} from "@t3tools/board-core";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ProjectService } from "./upstream.ts";

export type FileError = BoardNotFoundError | BoardInvalidRequestError | BoardInternalError;
const isFileError = (cause: unknown): cause is FileError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause._tag === "BoardNotFoundError" ||
    cause._tag === "BoardInvalidRequestError" ||
    cause._tag === "BoardInternalError");

/** Keeps the board's own errors and logs anything else (disk, database) behind one message. */
export const keepBoardErrors =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, FileError, R> =>
    effect.pipe(
      Effect.tapError((cause) =>
        isFileError(cause) ? Effect.void : Effect.logError(message, { cause }),
      ),
      Effect.mapError((cause): FileError =>
        isFileError(cause) ? cause : new BoardInternalError({ message }),
      ),
    );

export const checkName = (name: string) => {
  const problem = sharedFileNameProblem(name);
  return problem === undefined
    ? Effect.void
    : Effect.fail(new BoardInvalidRequestError({ message: problem }));
};

/**
 * Streams `body` into `<folder>/<name>`, replacing any file there in one rename so a reader never
 * sees half a file. Resolves with the sha256 and size of what was written.
 */
export const writeStreamed = Effect.fn("SharedFileStore.writeStreamed")(function* <E, R>(
  folder: string,
  name: string,
  body: Stream.Stream<Uint8Array, E, R>,
) {
  yield* checkName(name);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(folder, { recursive: true });
  const part = path.join(folder, `.upload-${NodeCrypto.randomUUID()}.part`);
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  return yield* Effect.gen(function* () {
    yield* Stream.run(
      body.pipe(
        Stream.map((chunk) => {
          hash.update(chunk);
          size += chunk.byteLength;
          return chunk;
        }),
      ),
      fs.sink(part),
    );
    yield* fs.rename(part, path.join(folder, name));
    return { sha256: hash.digest("hex"), size };
  }).pipe(Effect.ensuring(fs.remove(part, { force: true }).pipe(Effect.ignore)));
});

/** The shared-files folder of a t3 project on this machine, created when missing. */
const projectFolder = Effect.fn("SharedFileStore.projectFolder")(function* (projectId: ProjectId) {
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(projectId);
  if (Option.isNone(project))
    return yield* new BoardNotFoundError({
      message: "The workspace folder is not set up on this machine yet.",
    });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(project.value.workspaceRoot, SHARED_FILES_FOLDER);
  yield* fs.makeDirectory(folder, { recursive: true });
  // A link put in its place would let the hub write and delete files outside the workspace.
  if (
    (yield* fs.realPath(folder)) !==
    path.join(yield* fs.realPath(project.value.workspaceRoot), SHARED_FILES_FOLDER)
  )
    return yield* new BoardInvalidRequestError({
      message: `${SHARED_FILES_FOLDER} in the workspace folder is a link; replace it with a plain folder.`,
    });
  return folder;
});

export const writeProjectFile = Effect.fn("SharedFileStore.writeProjectFile")(function* <E, R>(
  projectId: ProjectId,
  name: string,
  body: Stream.Stream<Uint8Array, E, R>,
) {
  yield* checkName(name);
  return yield* writeStreamed(yield* projectFolder(projectId), name, body);
});

export const removeProjectFile = Effect.fn("SharedFileStore.removeProjectFile")(function* (
  projectId: ProjectId,
  name: string,
) {
  yield* checkName(name);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(path.join(yield* projectFolder(projectId), name), { force: true });
});
