/** The subfolder of a workspace's folder, on every machine, that holds the workspace's shared files. */
export const SHARED_FILES_FOLDER = "shared-files";

/**
 * Where a workspace folder (as stored, `~` allowed) keeps its shared files. A folder whose path
 * the board does not know gets the path relative to the agent's own folder.
 */
export function sharedFilesPath(folderPath: string): string {
  const folder = folderPath.trim().replace(/[\\/]+$/, "");
  return folder.length > 0 ? `${folder}/${SHARED_FILES_FOLDER}` : SHARED_FILES_FOLDER;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Why `name` cannot be a shared file's name, or undefined when it can: one plain file name, no folders. */
export function sharedFileNameProblem(name: string): string | undefined {
  if (name.trim().length === 0) return "The file needs a name.";
  if (name !== name.trim()) return "File names cannot start or end with spaces.";
  if (name === "." || name === "..") return "That is not a file name.";
  if (/[/\\]/.test(name)) return "File names cannot contain slashes.";
  if (CONTROL_CHARACTERS.test(name)) return "File names cannot contain control characters.";
  if (new TextEncoder().encode(name).length > 255) return "The file name is too long.";
  return undefined;
}
