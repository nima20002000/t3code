import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
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
    },
  ) {
    const client = yield* HttpClient.HttpClient;
    const httpRequest = HttpClientRequest.make(init.method)(url.toString()).pipe(
      HttpClientRequest.setHeaders(init.headers ?? {}),
      (request) => (init.body ? HttpClientRequest.bodyUrlParams(request, init.body) : request),
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
  readonly name: string;
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
      scope: `${AuthOrchestrationReadScope} ${AuthOrchestrationOperateScope}`,
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
    name: input.name,
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
