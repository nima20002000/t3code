import { assert, it } from "@effect/vitest";
import { AuthAccessTokenType, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { FetchHttpClient } from "effect/http";
import * as PeerPairing from "./PeerPairing.ts";
import * as PeerStore from "./PeerStore.ts";

const descriptor = (version: number) => ({
  environmentId: "remote-machine",
  label: "Office PC",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.0",
  orchestrationProtocolVersion: version,
  capabilities: {},
});

it.effect(
  "checks protocol before spending a pairing code and persists only full bearer grants",
  () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; body: string }> = [];
      let version = 1;
      let scope = "orchestration:read";
      const fetch: typeof globalThis.fetch = (input, init) => {
        requests.push({ url: String(input), body: String(init?.body ?? "") });
        return Promise.resolve(
          String(input).endsWith("/.well-known/t3/environment")
            ? Response.json(descriptor(version))
            : Response.json({
                access_token: "test-bearer",
                issued_token_type: AuthAccessTokenType,
                token_type: "Bearer",
                expires_in: 300,
                scope,
              }),
        );
      };
      const store = PeerStore.makeMemory();
      const pair = () =>
        PeerPairing.pair({
          name: "Remote",
          pairingUrlOrCode: "one-time-code",
          host: "http://peer.test",
          store,
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      const incompatible = yield* pair().pipe(Effect.result);
      assert.isTrue(Result.isFailure(incompatible));
      if (Result.isFailure(incompatible)) assert.equal(incompatible.failure.stage, "protocol");
      assert.deepEqual(
        requests.map((request) => new URL(request.url).pathname),
        ["/.well-known/t3/environment"],
      );
      assert.isUndefined(yield* store.get(EnvironmentId.make("remote-machine")));
      version = 2;
      const restricted = yield* pair().pipe(Effect.result);
      assert.isTrue(Result.isFailure(restricted));
      if (Result.isFailure(restricted)) assert.equal(restricted.failure.stage, "exchange");
      assert.isUndefined(yield* store.get(EnvironmentId.make("remote-machine")));
      scope = "orchestration:read orchestration:operate";
      const peer = yield* pair();
      assert.equal(peer.bearer, "test-bearer");
      assert.isString(peer.expiresAt);
      assert.deepEqual(yield* store.get(peer.environmentId), peer);
      const tokenRequests = requests.filter((request) => request.url.endsWith("/oauth/token"));
      assert.equal(
        new URLSearchParams(tokenRequests[1]?.body).get("subject_token"),
        "one-time-code",
      );
      yield* store.remove(peer.environmentId);
      assert.deepEqual(yield* store.list(), []);
      const unnamed = yield* PeerPairing.pair({
        pairingUrlOrCode: "http://peer.test/pair#token=link-token",
        store,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      assert.equal(unnamed.name, "Office PC");
    }),
);
