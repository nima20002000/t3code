import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardHttp from "./BoardHttp.ts";

const token = "reusable-dev-auth-token-that-is-long-enough";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const config = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const base = yield* ServerConfig.ServerConfig;
    return {
      ...base,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(token),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "board-http-" })));

const authRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
);
const routes = Layer.merge(authRoutes, BoardHttp.layer).pipe(
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(config),
  Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
  Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

it.live("authenticates paired clients and streams committed board events", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, {
        get: () => Effect.succeedNone,
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.die("not used"),
        remove: () => Effect.void,
      }),
    );
    yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      ({ handler }) =>
        Effect.tryPromise(async () => {
          const get = (path: string, cookie?: string) =>
            new Request(`http://127.0.0.1${path}`, { headers: cookie ? { cookie } : {} });
          const post = (path: string, body: string, cookie?: string) =>
            new Request(`http://127.0.0.1${path}`, {
              method: "POST",
              headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
              body,
            });
          const call = (request: Request) => handler(request, requestContext);
          assert.strictEqual((await call(get("/api/board/snapshot"))).status, 401);
          assert.strictEqual((await call(get("/api/board/events"))).status, 401);
          const dev = await call(post("/api/auth/browser-session", `{"credential":"${token}"}`));
          assert.strictEqual(dev.status, 200);
          const devCookie = dev.headers
            .getSetCookie()
            .find((value) => value.startsWith("t3_dev_session_"))
            ?.split(";", 1)[0];
          assert.isDefined(devCookie);
          const pairing = await call(
            post(
              "/api/auth/pairing-token",
              '{"scopes":["orchestration:read","orchestration:operate"]}',
              devCookie,
            ),
          );
          assert.strictEqual(pairing.status, 200);
          const credential = ((await pairing.json()) as { credential: string }).credential;
          const session = await call(post("/api/auth/browser-session", encodeJson({ credential })));
          assert.strictEqual(session.status, 200);
          const cookie = session.headers.getSetCookie()[0]?.split(";", 1)[0];
          assert.isDefined(cookie);
          assert.strictEqual((await call(get("/api/board/snapshot", cookie))).status, 200);
          const stream = await call(get("/api/board/events?afterSequence=0", cookie));
          assert.strictEqual(stream.status, 200);
          assert.include(stream.headers.get("content-type"), "text/event-stream");
          const reader = stream.body!.getReader();
          const event = reader.read();
          const workspace = await call(
            post("/api/board/workspaces", '{"id":"workspace","name":"Workspace"}', cookie),
          );
          assert.strictEqual(workspace.status, 200);
          const created = await call(
            post(
              "/api/board/workflows",
              '{"id":"workflow","name":"Workflow","workspaceId":"workspace"}',
              cookie,
            ),
          );
          assert.strictEqual(created.status, 200);
          const frame = await event;
          assert.include(new TextDecoder().decode(frame.value), '"kind":"workspace.upserted"');
          const kanban = await call(get("/api/board/workflows/workflow/kanban", cookie));
          assert.strictEqual(kanban.status, 200);
          assert.deepStrictEqual(await kanban.json(), []);
          assert.strictEqual(
            (await call(get("/api/board/workflows/missing/kanban", cookie))).status,
            404,
          );
          await reader.cancel();
        }),
      ({ dispose }) => Effect.promise(dispose),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
