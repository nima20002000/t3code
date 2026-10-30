import {
  AuthAccessTokenResult,
  AuthAccessWriteScope,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import type { Peer, PeerStore } from "./PeerStore.ts";

const decodeDescriptor = Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor);
const decodeToken = Schema.decodeUnknownEffect(AuthAccessTokenResult);

export class PeerPairingError extends Schema.TaggedError<PeerPairingError>()("PeerPairingError", {
  stage: Schema.Literals(["address", "descriptor", "protocol", "exchange", "store", "local"]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not pair the remote environment (${this.stage}).`;
  }
}

export class PeerHttpError extends Schema.TaggedError<PeerHttpError>()("PeerHttpError", {
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.status === undefined
      ? "Remote request failed."
      : `Remote request failed (HTTP ${this.status}).`;
  }
}

export const readDescriptor = Effect.fn("PeerPairing.readDescriptor")(function* (url: string) {
  const response = yield* request(new URL("/.well-known/t3/environment", url), {
    method: "GET",
  }).pipe(Effect.mapError((cause) => new PeerPairingError({ stage: "descriptor", cause })));
  const descriptor = yield* decodeDescriptor(response).pipe(
    Effect.mapError((cause) => new PeerPairingError({ stage: "descriptor", cause })),
  );
  if ((descriptor.orchestrationProtocolVersion ?? 1) !== ORCHESTRATION_PROTOCOL_VERSION) {
    return yield* new PeerPairingError({ stage: "protocol" });
  }
  return descriptor;
});

export const request = Effect.fn("PeerPairing.request")(
  function* (
    url: URL,
    init: {
      readonly method: "GET" | "POST";
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: URLSearchParams;
      readonly json?: unknown;
    },
  ) {
    const client = yield* HttpClient.HttpClient;
    const httpRequest = HttpClientRequest.make(init.method)(url.toString()).pipe(
      HttpClientRequest.setHeaders(init.headers ?? {}),
      (request) => (init.body ? HttpClientRequest.bodyUrlParams(request, init.body) : request),
      (request) =>
        init.json === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, init.json),
    );
    const response = yield* client.execute(httpRequest).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(
        (cause) =>
          new PeerHttpError({
            cause: HttpClientError.isHttpClientError(cause) ? cause.cause : cause,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new PeerHttpError({ status: response.status });
    }
    return yield* response.json.pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(
        (cause) =>
          new PeerHttpError({
            status: 200,
            cause: HttpClientError.isHttpClientError(cause) ? cause.cause : cause,
          }),
      ),
    );
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
);

export const pair = Effect.fn("PeerPairing.pair")(function* (input: {
  readonly name?: string;
  readonly pairingUrlOrCode: string;
  readonly host?: string;
  readonly localEnvironmentId?: EnvironmentId;
  readonly store: PeerStore;
}) {
  const target = yield* Effect.try({
    try: () =>
      resolveRemotePairingTarget(
        /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(input.pairingUrlOrCode.trim())
          ? { pairingUrl: input.pairingUrlOrCode }
          : {
              pairingCode: input.pairingUrlOrCode,
              ...(input.host === undefined ? {} : { host: input.host }),
            },
      ),
    catch: (cause) => new PeerPairingError({ stage: "address", cause }),
  });
  const descriptor = yield* readDescriptor(target.httpBaseUrl);
  if (descriptor.environmentId === input.localEnvironmentId) {
    return yield* new PeerPairingError({ stage: "local" });
  }
  const response = yield* request(new URL("/oauth/token", target.httpBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: target.credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      // Everything the link grants, so the hub can also let its own windows in (BoardPeers.windowPairing).
      scope: AuthStandardClientScopes.join(" "),
      client_label: "T3 Code Board",
      client_device_type: "bot",
    }),
  }).pipe(Effect.mapError((cause) => new PeerPairingError({ stage: "exchange", cause })));
  const token = yield* decodeToken(response).pipe(
    Effect.mapError((cause) => new PeerPairingError({ stage: "exchange", cause })),
  );
  const scopes = new Set(token.scope.split(/\s+/));
  if (
    token.token_type !== "Bearer" ||
    token.expires_in <= 0 ||
    !scopes.has(AuthOrchestrationReadScope) ||
    !scopes.has(AuthOrchestrationOperateScope)
  )
    return yield* new PeerPairingError({ stage: "exchange" });
  const peer: Peer = {
    id: descriptor.environmentId,
    name: input.name ?? descriptor.label,
    environmentId: descriptor.environmentId,
    url: target.httpBaseUrl,
    bearer: token.access_token,
    expiresAt: DateTime.formatIso(
      DateTime.addDuration(yield* DateTime.now, Duration.seconds(token.expires_in)),
    ),
  };
  yield* input.store
    .put(peer)
    .pipe(Effect.mapError((cause) => new PeerPairingError({ stage: "store", cause })));
  return peer;
});

// Only the fields the board reads, so a newer or older machine's extra fields never break it.
const decodeSession = Schema.decodeUnknownEffect(
  Schema.Struct({
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    permissions: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const decodePairingCredential = Schema.decodeUnknownEffect(
  Schema.Struct({ credential: Schema.NonEmptyString }),
);

/**
 * A one-time t3 pairing code on a paired machine for one of the hub's windows, granting only what
 * that window may do on the hub and the hub may do there. None when the hub's grant cannot mint codes
 * (machines added with a read/operate-only link).
 */
export const mintWindowPairingCode = Effect.fn("PeerPairing.mintWindowPairingCode")(function* (
  peer: Pick<Peer, "url" | "bearer">,
  callerScopes: ReadonlySet<string>,
) {
  const authorization = { authorization: `Bearer ${peer.bearer}` };
  const session = yield* request(new URL("/api/auth/session", peer.url), {
    method: "GET",
    headers: authorization,
  }).pipe(Effect.flatMap(decodeSession));
  const granted = new Set(session.permissions ?? session.scopes ?? []);
  const scopes = AuthStandardClientScopes.filter(
    (scope) => granted.has(scope) && callerScopes.has(scope),
  );
  if (!granted.has(AuthAccessWriteScope) || !scopes.includes(AuthOrchestrationReadScope)) {
    return null;
  }
  const response = yield* request(new URL("/api/auth/pairing-token", peer.url), {
    method: "POST",
    headers: authorization,
    json: { scopes },
  });
  return (yield* decodePairingCredential(response)).credential;
});
