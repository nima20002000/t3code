import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { CONTINUATION_GRACE_MS, makeRestartChain } from "./restartChain.ts";

const thread = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
};
const run = (
  id: string,
  status: OrchestrationV2Run["status"],
  continuationOf?: string,
  started = true,
): OrchestrationV2Run =>
  ({
    id: RunId.make(id),
    userMessageId: MessageId.make(`message:${id}`),
    status,
    startedAt: started ? "started" : null,
    ...(continuationOf === undefined
      ? {}
      : { restartContinuationOfRunId: RunId.make(continuationOf) }),
  }) as OrchestrationV2Run;
const brief = (settles: ReadonlyArray<{ runId: string; messageId: string; status: string }>) =>
  settles.map(({ runId, messageId, status }) => ({ runId, messageId, status }));

it("settles a turn t3 continued after a restart under the message that started it", () => {
  const chain = makeRestartChain(thread);
  assert.deepStrictEqual(chain.observe(run("r0", "cancelled"), 1, 0), []);
  assert.deepStrictEqual(chain.observe(run("r1", "running", "r0"), 2, 0), []);
  assert.deepStrictEqual(brief(chain.observe(run("r1", "completed", "r0"), 3, 0)), [
    { runId: "r1", messageId: "message:r0", status: "completed" },
  ]);
  assert.deepStrictEqual(chain.expire(CONTINUATION_GRACE_MS * 2), []);
});

it("follows a second restart through a continuation that never started", () => {
  const chain = makeRestartChain(thread);
  const settles = [
    run("r0", "cancelled"),
    run("r1", "cancelled", "r0", false),
    run("r2", "completed", "r1"),
  ].flatMap((entry) => chain.observe(entry, 4, 0));
  assert.deepStrictEqual(brief(settles), [
    { runId: "r2", messageId: "message:r0", status: "completed" },
  ]);
  assert.deepStrictEqual(chain.expire(CONTINUATION_GRACE_MS), []);
});

it("settles a cancel nobody continues only after the grace while connected", () => {
  const chain = makeRestartChain(thread);
  assert.deepStrictEqual(chain.observe(run("r0", "cancelled"), 1, 0), []);
  assert.deepStrictEqual(chain.expire(CONTINUATION_GRACE_MS - 1), []);
  // The machine went away and came back: t3 gets a full grace again.
  chain.connected(CONTINUATION_GRACE_MS - 1);
  assert.deepStrictEqual(chain.expire(CONTINUATION_GRACE_MS), []);
  assert.deepStrictEqual(brief(chain.expire(2 * CONTINUATION_GRACE_MS - 1)), [
    { runId: "r0", messageId: "message:r0", status: "cancelled" },
  ]);
  assert.deepStrictEqual(chain.expire(3 * CONTINUATION_GRACE_MS), []);
});

it("settles failed and interrupted turns at once", () => {
  const chain = makeRestartChain(thread);
  assert.deepStrictEqual(
    brief(
      [run("a", "failed"), run("b", "interrupted")].flatMap((entry) => chain.observe(entry, 1, 0)),
    ),
    [
      { runId: "a", messageId: "message:a", status: "failed" },
      { runId: "b", messageId: "message:b", status: "interrupted" },
    ],
  );
});
