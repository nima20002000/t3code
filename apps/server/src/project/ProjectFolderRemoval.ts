import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import type { ProjectId } from "@t3tools/contracts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export class ProjectFolderRefusedError extends Schema.TaggedError<ProjectFolderRefusedError>()(
  "ProjectFolderRefusedError",
  { workspaceRoot: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Refused to remove ${this.workspaceRoot}: ${this.reason}`;
  }
}

/** True when `inner` is `outer` or lies below it (a name like `..x` is not "outside"). */
export function isWithin(path: Path.Path, outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Deletes the folder at `confirmedPath` (what the user saw; `~` is this machine's home), only when
 * it resolves to the project's current root and holds no other project, soft-deleted or not, and
 * is neither home, a parent of home, nor shallower than two segments. Call it while the project is
 * still active: that keeps the root from being claimed by a new project during the check.
 */
export const removeProjectFolder = Effect.fn("ProjectFolderRemoval.remove")(function* (
  projectId: ProjectId,
  confirmedPath: string,
) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const own = yield* projects.get(projectId, { includeDeleted: true });
  // A folder whose project was never created on this machine has nothing to delete.
  if (Option.isNone(own)) return { removed: false };
  const refuse = (reason: string) =>
    new ProjectFolderRefusedError({ workspaceRoot: confirmedPath, reason });

  const home = NodeOS.homedir();
  const expanded =
    confirmedPath === "~" || confirmedPath.startsWith("~/")
      ? path.join(home, confirmedPath.slice(1))
      : confirmedPath;
  if (!path.isAbsolute(expanded)) return yield* refuse("the path is not absolute.");
  // Symlinked spellings of the same folder must compare equal, so everything is resolved.
  const canonical = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  if (!(yield* fileSystem.exists(expanded))) return { removed: false };
  const target = yield* canonical(expanded);
  if ((yield* canonical(own.value.workspaceRoot)) !== target)
    return yield* refuse("it is not this project's folder.");
  if (target.split(path.sep).filter(Boolean).length < 2)
    return yield* refuse("the path is too shallow.");
  if (isWithin(path, target, yield* canonical(home)))
    return yield* refuse("the path is the home folder or a parent of it.");
  const others = yield* projects.list({ includeDeleted: true });
  for (const other of others) {
    if (other.projectId === projectId) continue;
    const otherRoot = yield* canonical(other.workspaceRoot);
    // A deleted project that sat on this very folder is history, not a second owner.
    if (other.deletedAt !== null && otherRoot === target) continue;
    if (isWithin(path, target, otherRoot)) return yield* refuse("another project lives inside it.");
  }
  yield* fileSystem.remove(target, { recursive: true, force: true });
  return { removed: true };
});
