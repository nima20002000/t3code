import type {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2TurnItem,
  ProjectId,
  RunId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export interface BoardDriverThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

export interface BoardDriverLaunch {
  readonly environmentId: EnvironmentId;
  readonly launch: Omit<OrchestrationV2ThreadLaunchInput, "threadId" | "initialMessage"> & {
    readonly threadId: ThreadId;
    readonly initialMessage?: NonNullable<OrchestrationV2ThreadLaunchInput["initialMessage"]> & {
      readonly messageId: MessageId;
    };
  };
}

export interface BoardDriverSend {
  readonly thread: BoardDriverThread;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
}

export interface BoardDriverSendResult {
  readonly runId: RunId;
  readonly sequence: number;
}

export interface BoardDriverSettled {
  readonly thread: BoardDriverThread;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly status: "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back";
  readonly sequence: number;
}

export interface BoardDriverAssistantMessage {
  readonly id: MessageId;
  readonly text: string;
}

export class NodeDriverError extends Schema.TaggedError<NodeDriverError>()("NodeDriverError", {
  operation: Schema.Literals([
    "launch",
    "send",
    "subscribeSettled",
    "readLatestAssistant",
    "interrupt",
    "ensureProject",
    "deleteProject",
    "schedule",
    "projectBusy",
    "browser",
    "plans",
  ]),
  message: Schema.String,
  /** The outcome is unknown, so repeating the call with the same ids is safe. */
  retryable: Schema.optionalKey(Schema.Boolean),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * The steps of the run's latest to-do list, for `NodeDriver.readPlan`: the newest to-do item of the
 * run's timeline. Plan ids cannot order lists (a run may hold several), so plans are the fallback
 * only when the timeline no longer holds the run's items.
 */
export function latestTodoList(
  records: {
    readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  },
  runId: RunId,
): ReadonlyArray<OrchestrationV2PlanStep> | null {
  let latest: Extract<OrchestrationV2TurnItem, { readonly type: "todo_list" }> | undefined;
  for (const item of records.turnItems)
    if (
      item.type === "todo_list" &&
      item.runId === runId &&
      (latest === undefined || item.ordinal > latest.ordinal)
    )
      latest = item;
  if (latest) return latest.steps;
  const plan = records.plans.findLast(
    (entry) => entry.kind === "todo_list" && entry.runId === runId && entry.status !== "superseded",
  );
  return plan?.kind === "todo_list" ? plan.steps : null;
}

export interface BoardDriverProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface BoardDriverScheduledTask {
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId;
}

export interface NodeDriver {
  /**
   * Registers the t3 project for a workspace folder, creating the folder when it is missing.
   * `adopted` is true when the folder already existed, so the board must never delete it.
   */
  readonly ensureProject: (
    input: BoardDriverProject & { readonly title: string; readonly path: string },
  ) => Effect.Effect<{ readonly adopted: boolean }, NodeDriverError>;
  /**
   * Removes the t3 project and its threads. With `removeFolderPath`, first deletes that folder (the
   * path the user confirmed) through t3's `projects.removeFolder`, which refuses anything but the
   * project's own root; if that fails the project is left untouched.
   */
  readonly deleteProject: (
    input: BoardDriverProject & { readonly removeFolderPath?: string },
  ) => Effect.Effect<void, NodeDriverError>;
  readonly launch: (input: BoardDriverLaunch) => Effect.Effect<BoardDriverThread, NodeDriverError>;
  /**
   * Hands the machine's browser tabs of `from` to `to` with their live pages, so they never reload
   * and the agent of `to` reuses them: an agent's new chat keeps the browser its last one used.
   */
  readonly carryBrowserTabs: (input: {
    readonly environmentId: EnvironmentId;
    readonly from: ThreadId;
    readonly to: ThreadId;
  }) => Effect.Effect<void, NodeDriverError>;
  /** Whether any thread in the project is running on that machine, such as an agent's own chat. */
  readonly projectBusy: (input: BoardDriverProject) => Effect.Effect<boolean, NodeDriverError>;
  readonly send: (input: BoardDriverSend) => Effect.Effect<BoardDriverSendResult, NodeDriverError>;
  readonly subscribeSettled: (input: {
    readonly thread: BoardDriverThread;
    readonly afterSequence?: number;
  }) => Stream.Stream<BoardDriverSettled, NodeDriverError>;
  /**
   * The steps of each to-do list the thread's agent writes after `afterSequence` (Claude's TodoWrite,
   * Codex's update_plan), live while it works. Providers that keep no to-do list emit nothing.
   */
  readonly subscribePlans: (input: {
    readonly thread: BoardDriverThread;
    readonly afterSequence: number;
  }) => Stream.Stream<ReadonlyArray<OrchestrationV2PlanStep>, NodeDriverError>;
  /** The steps of the latest to-do list the agent wrote in that run, or null when it wrote none. */
  readonly readPlan: (input: {
    readonly thread: BoardDriverThread;
    readonly runId: RunId;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2PlanStep> | null, NodeDriverError>;
  readonly readLatestAssistant: (input: {
    readonly thread: BoardDriverThread;
    readonly runId?: RunId;
  }) => Effect.Effect<BoardDriverAssistantMessage | null, NodeDriverError>;
  readonly interrupt: (input: {
    readonly thread: BoardDriverThread;
    readonly commandId: CommandId;
    readonly runId?: RunId;
  }) => Effect.Effect<void, NodeDriverError>;
  /** t3's scheduled tasks on that machine, which keeps firing them while the hub is off. */
  readonly getScheduledTask: (
    input: BoardDriverScheduledTask,
  ) => Effect.Effect<ScheduledTask | null, NodeDriverError>;
  readonly upsertScheduledTask: (input: {
    readonly environmentId: EnvironmentId;
    readonly task: ScheduledTaskUpsertInput & { readonly id: ScheduledTaskId };
  }) => Effect.Effect<ScheduledTask, NodeDriverError>;
  readonly setScheduledTaskEnabled: (
    input: BoardDriverScheduledTask & { readonly enabled: boolean },
  ) => Effect.Effect<void, NodeDriverError>;
  /** Succeeds when the task is already gone. */
  readonly deleteScheduledTask: (
    input: BoardDriverScheduledTask,
  ) => Effect.Effect<void, NodeDriverError>;
}
