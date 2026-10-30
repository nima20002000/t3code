import { BoardStoredFileSchema } from "@t3tools/board-core";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as BoardStore from "./BoardStore.ts";
import * as SharedFileStore from "./SharedFileStore.ts";
import { ProjectService, ServerEnvironment } from "./upstream.ts";

/** Why a machine did not take a shared file; the sync worker shows it and tries again later. */
export class ShipError extends Schema.TaggedError<ShipError>()("ShipError", {
  message: Schema.String,
}) {}

interface Target {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly name: string;
}

/** Copies the hub's shared files into a workspace's project folder on one machine. */
export class FileShipper extends Context.Service<
  FileShipper,
  {
    /** Resolves with the sha256 of what the machine stored. */
    readonly put: (input: Target & { readonly source: string }) => Effect.Effect<string, ShipError>;
    readonly remove: (input: Target) => Effect.Effect<void, ShipError>;
  }
>()("t3/board/FileShipper") {}

const decodeStored = Schema.decodeUnknownEffect(BoardStoredFileSchema);
const failureTag = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }));

const make = Effect.gen(function* () {
  const store = yield* BoardStore.BoardStore;
  const fs = yield* FileSystem.FileSystem;
  const localId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ProjectService.ProjectService
  >();
  const local = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ProjectService.ProjectService>,
  ) =>
    effect.pipe(
      Effect.provideContext(services),
      Effect.mapError(
        (cause) =>
          new ShipError({
            message:
              typeof cause === "object" && cause !== null && "message" in cause
                ? String(cause.message)
                : "Could not write the file on this machine.",
          }),
      ),
    );
  const remote = Effect.fn("FileShipper.remote")(
    function* (
      target: Target,
      build: (
        url: string,
      ) => Effect.Effect<
        HttpClientRequest.HttpClientRequest,
        PlatformError.PlatformError,
        FileSystem.FileSystem
      >,
    ) {
      const peer = yield* store
        .getPeer(target.environmentId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!peer)
        return yield* new ShipError({ message: "This machine is no longer paired with the hub." });
      const url = new URL(
        `/api/board/project-files/${encodeURIComponent(target.projectId)}/${encodeURIComponent(target.name)}`,
        peer.url,
      ).toString();
      const request = yield* build(url).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(() => new ShipError({ message: "Could not read the file on the hub." })),
      );
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(HttpClientRequest.bearerToken(request, peer.bearer))
        .pipe(
          Effect.mapError(
            () => new ShipError({ message: `${peer.name} is offline or can't be reached.` }),
          ),
        );
      if (response.status >= 200 && response.status < 300) return response;
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
      const tag = failureTag(body);
      if (response.status === 404 && tag._tag === "None")
        return yield* new ShipError({
          message: `${peer.name} runs an older version without shared files. Update it to receive them.`,
        });
      const message =
        typeof body === "object" && body !== null && "message" in body
          ? String(body.message)
          : `HTTP ${response.status}`;
      return yield* new ShipError({ message: `${peer.name} did not take the file: ${message}` });
    },
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  );

  const put = Effect.fn("FileShipper.put")(function* (input: Target & { readonly source: string }) {
    if (input.environmentId === localId)
      return (yield* local(
        SharedFileStore.writeProjectFile(input.projectId, input.name, fs.stream(input.source)),
      )).sha256;
    const response = yield* remote(input, (url) =>
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyFile(input.source, { contentType: "application/octet-stream" }),
      ),
    );
    const stored = yield* response.json.pipe(
      Effect.flatMap(decodeStored),
      Effect.mapError(
        () => new ShipError({ message: "The machine answered with an unknown reply." }),
      ),
    );
    return stored.sha256;
  });
  const remove = Effect.fn("FileShipper.remove")(function* (input: Target) {
    if (input.environmentId === localId)
      return yield* local(SharedFileStore.removeProjectFile(input.projectId, input.name));
    yield* remote(input, (url) => Effect.succeed(HttpClientRequest.post(`${url}/delete`)));
  });
  return FileShipper.of({ put, remove });
});

export const layer = Layer.effect(FileShipper, make);
