// @effect-diagnostics nodeBuiltinImport:off -- The fake provider reuses recorded protocol frames.
import * as NodeFS from "node:fs";
import type * as CodexAdapter from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

const frames = NodeFS.readFileSync(
  new URL(
    "../orchestration-v2/testkit/fixtures/provider_thread_resume/codex_transcript.ndjson",
    import.meta.url,
  ),
  "utf8",
)
  .trim()
  .split("\n")
  .map(
    (line) => JSON.parse(line) as { type: string; label?: string; frame?: Record<string, unknown> },
  );
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Number),
      method: Schema.String,
      params: Schema.optionalKey(
        Schema.Struct({
          threadId: Schema.optionalKey(Schema.String),
          input: Schema.optionalKey(
            Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
          ),
        }),
      ),
    }),
  ),
);

const recorded = (label: string) => {
  const frame = frames.find(
    (entry) => entry.type === "emit_inbound" && entry.label === label,
  )?.frame;
  if (!frame) throw new Error(`Missing provider frame: ${label}`);
  return structuredClone(frame);
};

export const held = Promise.withResolvers<void>();
export const interrupted = Promise.withResolvers<void>();
let threadNumber = 0;
let turnNumber = 0;

export function layer(tag: typeof CodexAdapter.CodexAppServerClientFactory) {
  return Layer.succeed(tag, {
    open: () =>
      Effect.gen(function* () {
        const incoming = yield* Queue.unbounded<Uint8Array>();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let remainder = "";
        let activeThreadId: string | undefined;
        let activeTurnId: string | undefined;
        const emit = (frame: unknown) =>
          Queue.offer(incoming, encoder.encode(`${encodeJson(frame)}\n`));
        const outbound = (chunk: string | Uint8Array) =>
          Effect.gen(function* () {
            remainder +=
              typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
            const lines = remainder.split("\n");
            remainder = lines.pop() ?? "";
            for (const line of lines) {
              const message = yield* decodeFrame(line).pipe(Effect.orDie);
              if (message.method === "initialized") continue;
              if (message.method === "initialize") {
                yield* emit({ ...recorded("initialize"), id: message.id });
                continue;
              }
              if (message.method === "thread/start") {
                const response = recorded("thread/start") as {
                  result: { thread: Record<string, unknown> };
                };
                const id = `board-fake-thread-${++threadNumber}`;
                yield* emit({
                  id: message.id,
                  result: {
                    ...response.result,
                    thread: { ...response.result.thread, id, sessionId: id },
                  },
                });
                continue;
              }
              if (message.method === "turn/start") {
                const threadId = message.params?.threadId;
                const turnId = `board-fake-turn-${++turnNumber}`;
                activeThreadId = threadId;
                activeTurnId = turnId;
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
                const text = message.params?.input?.map((part) => part.text ?? "").join("\n") ?? "";
                if (text.includes("Hold this run")) {
                  held.resolve();
                  continue;
                }
                const result =
                  text.startsWith("[Board] You are the agent") &&
                  text.includes("You can send requests to:\n- Child")
                    ? {
                        summary: "briefing reply",
                        data: null,
                        routing: {
                          kind: "request",
                          requests: [{ to: "Child", task: "Do not route" }],
                        },
                      }
                    : text.startsWith("[Board] Workflow run started")
                      ? {
                          summary: "delegate",
                          data: null,
                          routing: {
                            kind: "request",
                            requests: [{ to: "Child", task: "Deliver result" }],
                          },
                        }
                      : text.startsWith("[Board] Work request")
                        ? { summary: "child returned", data: 42, routing: { kind: "return" } }
                        : text.startsWith("[Board] Work return")
                          ? {
                              summary: "run finished",
                              data: { joined: true },
                              routing: { kind: "finish" },
                            }
                          : null;
                const item = {
                  type: "agentMessage",
                  id: `answer-${turnId}`,
                  text:
                    result === null
                      ? "Briefing noted."
                      : `\`\`\`json\n${encodeJson(result)}\n\`\`\``,
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
                continue;
              }
              if (message.method === "turn/interrupt") {
                yield* emit({ id: message.id, result: {} });
                yield* emit({
                  method: "turn/completed",
                  params: {
                    threadId: activeThreadId,
                    turn: {
                      id: activeTurnId,
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
                interrupted.resolve();
                continue;
              }
              if (message.id !== undefined)
                yield* emit({
                  id: message.id,
                  error: { code: -32601, message: "Unsupported fake provider method" },
                });
            }
          });
        return yield* CodexClient.make(
          Stdio.make({
            args: Effect.succeed([]),
            stdin: Stream.fromQueue(incoming),
            stdout: () => Sink.forEach(outbound),
            stderr: () => Sink.drain,
          }),
        );
      }),
  });
}
