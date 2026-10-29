import type {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadLaunchInput,
  ProjectId,
  RunId,
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
  ]),
  message: Schema.String,
  /** The outcome is unknown, so repeating the call with the same ids is safe. */
  retryable: Schema.optionalKey(Schema.Boolean),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface BoardDriverProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
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
   * Removes the t3 project and its threads. With `removeFolder`, also deletes the project's own
   * folder through t3's `projects.removeFolder`, which refuses roots, home and shared parents.
   */
  readonly deleteProject: (
    input: BoardDriverProject & { readonly removeFolder?: boolean },
  ) => Effect.Effect<void, NodeDriverError>;
  readonly launch: (input: BoardDriverLaunch) => Effect.Effect<BoardDriverThread, NodeDriverError>;
  readonly send: (input: BoardDriverSend) => Effect.Effect<BoardDriverSendResult, NodeDriverError>;
  readonly subscribeSettled: (input: {
    readonly thread: BoardDriverThread;
    readonly afterSequence?: number;
  }) => Stream.Stream<BoardDriverSettled, NodeDriverError>;
  readonly readLatestAssistant: (input: {
    readonly thread: BoardDriverThread;
    readonly runId?: RunId;
  }) => Effect.Effect<BoardDriverAssistantMessage | null, NodeDriverError>;
  readonly interrupt: (input: {
    readonly thread: BoardDriverThread;
    readonly commandId: CommandId;
    readonly runId?: RunId;
  }) => Effect.Effect<void, NodeDriverError>;
}
