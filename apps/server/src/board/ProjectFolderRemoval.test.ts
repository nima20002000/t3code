import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import { isWithin, removeProjectFolder } from "../project/ProjectFolderRemoval.ts";
import { ProjectStore } from "./upstream.ts";

const projectId = ProjectId.make("p");
const withRoots = (roots: {
  readonly own: string;
  readonly others?: ReadonlyArray<string>;
  readonly deleted?: boolean;
}) =>
  Effect.provideService(
    ProjectStore.ProjectStoreV2,
    ProjectStore.ProjectStoreV2.of({
      get: () => Effect.succeedSome({ projectId, workspaceRoot: roots.own } as never),
      list: () =>
        Effect.succeed([
          { projectId, workspaceRoot: roots.own },
          ...(roots.others ?? []).map((workspaceRoot, i) => ({
            projectId: `o${i}`,
            workspaceRoot,
            deletedAt: roots.deleted === true ? "2026-01-01T00:00:00.000Z" : null,
          })),
        ] as never),
    } as never),
  );

const tempParent = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectory({ prefix: "board-folder-" });
});

it.effect("deletes the confirmed folder only when it is the project's root", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* tempParent;
    const own = path.join(parent, "own");
    const sibling = path.join(parent, "sibling");
    const moved = path.join(parent, "moved");
    for (const dir of [path.join(own, "deep"), sibling, moved])
      yield* fileSystem.makeDirectory(dir, { recursive: true });
    // The project root was changed to `moved` after the user confirmed `own`.
    const mismatch = yield* removeProjectFolder(projectId, own).pipe(
      withRoots({ own: moved }),
      Effect.flip,
    );
    assert.strictEqual(mismatch._tag, "ProjectFolderRefusedError");
    assert.isTrue(yield* fileSystem.exists(own));
    const remove = removeProjectFolder(projectId, own).pipe(withRoots({ own, others: [sibling] }));
    assert.deepStrictEqual(yield* remove, { removed: true });
    assert.isFalse(yield* fileSystem.exists(own));
    assert.isTrue(yield* fileSystem.exists(sibling));
    assert.deepStrictEqual(yield* remove, { removed: false });
    yield* fileSystem.remove(parent, { recursive: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses roots, home, parents of home and relative paths", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = NodeOS.homedir();
    for (const own of ["/", "/home", home, path.dirname(home), "relative/dir"]) {
      const refused = yield* removeProjectFolder(projectId, own).pipe(
        withRoots({ own }),
        Effect.flip,
      );
      assert.strictEqual(refused._tag, "ProjectFolderRefusedError", own);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses a folder holding another project, however the other is spelled", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* tempParent;
    const own = path.join(parent, "work");
    yield* fileSystem.makeDirectory(path.join(own, "..important"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(own, "inner"), { recursive: true });
    yield* fileSystem.symlink(path.join(own, "inner"), path.join(parent, "alias"));
    for (const other of [path.join(own, "..important"), path.join(parent, "alias")]) {
      const refused = yield* removeProjectFolder(projectId, own).pipe(
        withRoots({ own, others: [other] }),
        Effect.flip,
      );
      assert.strictEqual(refused._tag, "ProjectFolderRefusedError", other);
      assert.isTrue(yield* fileSystem.exists(own));
    }
    yield* fileSystem.remove(parent, { recursive: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a deleted project that sat on the same folder does not block its removal", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* tempParent;
    const own = path.join(parent, "work");
    yield* fileSystem.makeDirectory(own);
    const result = yield* removeProjectFolder(projectId, own).pipe(
      withRoots({ own, others: [own], deleted: true }),
    );
    assert.deepStrictEqual(result, { removed: true });
    yield* fileSystem.remove(parent, { recursive: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("treats ..name as inside, not outside", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    assert.isTrue(isWithin(path, "/srv/work", "/srv/work/..important"));
    assert.isFalse(isWithin(path, "/srv/work", "/srv/other"));
    assert.isFalse(isWithin(path, "/srv/work", "/srv"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
