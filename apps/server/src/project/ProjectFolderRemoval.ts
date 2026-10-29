import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import type { ProjectId } from "@t3tools/contracts";
import * as ProjectService from "./ProjectService.ts";

export class ProjectFolderRefusedError extends Schema.TaggedError<ProjectFolderRefusedError>()(
  "ProjectFolderRefusedError",
  { workspaceRoot: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Refused to remove ${this.workspaceRoot}: ${this.reason}`;
  }
}

/** Why a project's folder must not be deleted, or null. Never a root, home, a parent of home or a folder holding another project. */
export function folderRefusal(
  path: Path.Path,
  workspaceRoot: string,
  otherRoots: ReadonlyArray<string>,
  home = NodeOS.homedir(),
): string | null {
  if (!path.isAbsolute(workspaceRoot)) return "the path is not absolute.";
  const root = path.resolve(workspaceRoot);
  const contains = (inner: string) => {
    const relative = path.relative(root, path.resolve(inner));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  if (root.split(path.sep).filter(Boolean).length < 2) return "the path is too shallow.";
  if (contains(home)) return "the path is the home folder or a parent of it.";
  if (otherRoots.some(contains)) return "another project lives inside it.";
  return null;
}

/** Deletes a project's own workspace folder (also after the project was deleted) and says whether it existed. */
export const removeProjectFolder = Effect.fn("ProjectFolderRemoval.remove")(function* (
  projectId: ProjectId,
) {
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* projects.getById(projectId, { includeDeleted: true });
  if (Option.isNone(project)) return yield* new ProjectService.ProjectNotFoundError({ projectId });
  const workspaceRoot = project.value.workspaceRoot;
  const others = (yield* projects.snapshot).projects
    .filter((other) => other.id !== projectId)
    .map((other) => other.workspaceRoot);
  const refuse = (reason: string) => new ProjectFolderRefusedError({ workspaceRoot, reason });
  const direct = folderRefusal(path, workspaceRoot, others);
  if (direct !== null) return yield* refuse(direct);
  if (!(yield* fileSystem.exists(workspaceRoot))) return { removed: false };
  const real = yield* fileSystem.realPath(workspaceRoot);
  const resolved = folderRefusal(path, real, others);
  if (resolved !== null) return yield* refuse(resolved);
  yield* fileSystem.remove(real, { recursive: true, force: true });
  return { removed: true };
});
