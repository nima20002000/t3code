import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import { folderRefusal, removeProjectFolder } from "../project/ProjectFolderRemoval.ts";
import { ProjectService } from "./upstream.ts";

const projectId = ProjectId.make("p");
const withRoots = (roots: { readonly own: string; readonly others?: ReadonlyArray<string> }) =>
  Effect.provideService(
    ProjectService.ProjectService,
    ProjectService.ProjectService.of({
      getById: () => Effect.succeedSome({ workspaceRoot: roots.own } as never),
      snapshot: Effect.succeed({
        projects: (roots.others ?? []).map((workspaceRoot, i) => ({ id: `o${i}`, workspaceRoot })),
      } as never),
    } as never),
  );

it.effect("deletes the project's own folder and nothing beside it", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.makeTempDirectory({ prefix: "board-folder-" });
    const own = path.join(parent, "own");
    const sibling = path.join(parent, "sibling");
    yield* fileSystem.makeDirectory(path.join(own, "deep"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(own, "deep", "a.txt"), "x");
    yield* fileSystem.makeDirectory(sibling);
    const remove = removeProjectFolder(projectId).pipe(withRoots({ own, others: [sibling] }));
    assert.deepStrictEqual(yield* remove, { removed: true });
    assert.isFalse(yield* fileSystem.exists(own));
    assert.isTrue(yield* fileSystem.exists(sibling));
    assert.deepStrictEqual(yield* remove, { removed: false });
    yield* fileSystem.remove(parent, { recursive: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses roots, home, parents of home, relative paths and shared parents", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = NodeOS.homedir();
    for (const own of ["/", "/home", home, path.dirname(home), "relative/dir"]) {
      assert.notStrictEqual(folderRefusal(path, own, []), null, own);
      const refused = yield* removeProjectFolder(projectId).pipe(withRoots({ own }), Effect.flip);
      assert.strictEqual(refused._tag, "ProjectFolderRefusedError", own);
    }
    assert.notStrictEqual(folderRefusal(path, "/srv/shared", ["/srv/shared/inner"]), null);
    assert.strictEqual(folderRefusal(path, path.join(home, "t3-workspaces", "w"), []), null);
  }).pipe(Effect.provide(NodeServices.layer)),
);
