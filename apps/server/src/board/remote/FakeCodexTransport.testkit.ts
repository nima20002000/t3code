// @effect-diagnostics nodeBuiltinImport:off -- Read a recorded provider transport response as a fixture.
import * as NodeFS from "node:fs";
import type * as CodexAdapter from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

const fixturePath = new URL(
  "../../orchestration-v2/testkit/fixtures/provider_thread_resume/codex_transcript.ndjson",
  import.meta.url,
);
const decodeFrame = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Number),
      method: Schema.String,
    }),
  ),
);
const frames = NodeFS.readFileSync(fixturePath, "utf8")
  .trim()
  .split("\n")
  .map(
    (line) => JSON.parse(line) as { type: string; label?: string; frame?: Record<string, unknown> },
  );
const recorded = (label: string) => {
  const frame = frames.find(
    (entry) => entry.type === "emit_inbound" && entry.label === label,
  )?.frame;
  if (!frame) throw new Error(`Missing fake transport fixture: ${label}`);
  return structuredClone(frame);
};

export function layer(tag: typeof CodexAdapter.CodexAppServerClientFactory) {
  return Layer.succeed(tag, {
    open: () =>
      Effect.gen(function* () {
        const incoming = yield* Queue.unbounded<Uint8Array>();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let remainder = "";
        let turnNumber = 0;
        const threadId = "01a0d5ef-62bd-7c20-861b-0528ff7d86bd";
        const emit = (frame: unknown) =>
          Queue.offer(incoming, encoder.encode(`${JSON.stringify(frame)}\n`));
        const outbound = (chunk: string | Uint8Array) =>
          Effect.gen(function* () {
            remainder +=
              typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
            const lines = remainder.split("\n");
            remainder = lines.pop() ?? "";
            for (const line of lines) {
              const message = yield* decodeFrame(line).pipe(Effect.orDie);
              if (message.method === "initialized") continue;
              if (message.method === "initialize" || message.method === "thread/start") {
                const response = recorded(message.method);
                yield* emit({ ...response, id: message.id });
                continue;
              }
              if (message.method === "turn/start") {
                turnNumber++;
                const turnId = `fake-turn-${turnNumber}`;
                const response = recorded("turn/start") as {
                  result: { turn: Record<string, unknown> };
                };
                yield* emit({
                  id: message.id,
                  result: { turn: { ...response.result.turn, id: turnId } },
                });
                const started = recorded("turn/started") as {
                  method: string;
                  params: { turn: Record<string, unknown> };
                };
                yield* emit({
                  method: started.method,
                  params: { threadId, turn: { ...started.params.turn, id: turnId } },
                });
                if (turnNumber === 1) {
                  const item = {
                    type: "agentMessage",
                    id: "fake-answer",
                    text: "fake result",
                    phase: "final_answer",
                    memoryCitation: null,
                    delivery: null,
                    questions: null,
                  };
                  yield* emit({
                    method: "item/completed",
                    params: { threadId, turnId, item, completedAtMs: 1790295635269 },
                  });
                  yield* emit({
                    method: "turn/completed",
                    params: {
                      threadId,
                      turn: {
                        id: turnId,
                        items: [item],
                        itemsView: "summary",
                        status: "completed",
                        error: null,
                        startedAt: 1790295630,
                        completedAt: 1790295635,
                        durationMs: 4607,
                      },
                    },
                  });
                }
                continue;
              }
              if (message.method === "turn/interrupt") {
                yield* emit({ id: message.id, result: {} });
                yield* emit({
                  method: "turn/completed",
                  params: {
                    threadId,
                    turn: {
                      id: `fake-turn-${turnNumber}`,
                      items: [],
                      itemsView: "summary",
                      status: "interrupted",
                      error: null,
                      startedAt: 1790295630,
                      completedAt: 1790295635,
                      durationMs: 4607,
                    },
                  },
                });
                continue;
              }
              if (message.id !== undefined)
                yield* emit({
                  id: message.id,
                  error: { code: -32601, message: "Unsupported fake provider method" },
                });
            }
          });
        const stdio = Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(incoming),
          stdout: () => Sink.forEach(outbound),
          stderr: () => Sink.drain,
        });
        return yield* CodexClient.make(stdio);
      }),
  });
}
