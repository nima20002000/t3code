import {
  EnvironmentAuthenticatedAuth,
  EnvironmentId,
  EnvironmentScopeRequiredError,
  ModelSelection,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { BoardScheduleRuns, BoardTimingSchema } from "./timing.ts";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

const Id = TrimmedNonEmptyString;
const OptionalAuthHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

export const BoardAgentProfileSchema = Schema.Literals(["worker", "orchestrator"]);
export const BoardNodeSchema = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  profile: BoardAgentProfileSchema,
  environmentId: EnvironmentId,
  modelSelection: ModelSelection,
  prompt: Schema.optionalKey(Schema.String),
  chat: Schema.optionalKey(
    Schema.Struct({
      environmentId: EnvironmentId,
      projectId: ProjectId,
      threadId: ThreadId,
      startedAt: Schema.optionalKey(Schema.String),
    }),
  ),
  schedule: Schema.optionalKey(
    Schema.Struct({
      environmentId: EnvironmentId,
      taskId: ScheduledTaskId,
      threadId: Schema.optionalKey(ThreadId),
      rebind: Schema.optionalKey(
        Schema.Struct({
          modelSelection: Schema.optionalKey(ModelSelection),
          runtimeMode: Schema.optionalKey(RuntimeMode),
          interactionMode: Schema.optionalKey(ProviderInteractionMode),
        }),
      ),
    }),
  ),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  size: Schema.optionalKey(Schema.Number),
  x: Schema.Number,
  y: Schema.Number,
});
export const BoardWorkspaceFolderSchema = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  path: Schema.String,
  managed: Schema.Boolean,
});
export const BoardWorkspaceSchema = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  folders: Schema.Array(BoardWorkspaceFolderSchema),
});
export type BoardWorkspace = typeof BoardWorkspaceSchema.Type;
export const BoardKanbanCardSchema = Schema.Struct({
  id: Id,
  title: Schema.String,
  body: Schema.String,
  status: Schema.Literals(["todo", "doing", "waiting_for_human", "blocked", "done"]),
  reason: Schema.optionalKey(Schema.String),
  assigneeNodeId: Schema.optionalKey(Id),
  updatedBy: Schema.String,
  updatedAt: Schema.String,
  runId: Schema.optionalKey(Schema.String),
  moves: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        status: Schema.Literals(["todo", "doing", "waiting_for_human", "blocked", "done"]),
        by: Schema.String,
        at: Schema.String,
      }),
    ),
  ),
});
export const BoardEdgeSchema = Schema.Struct({ a: Id, b: Id });
export const BoardPendingWakeSchema = Schema.Struct({ id: Id, from: Id, to: Id });
export const BoardLogEntrySchema = Schema.Struct({
  id: Id,
  at: Schema.String,
  kind: Schema.Literals(["wake", "result", "info", "run", "error"]),
  text: Schema.String,
});
export const BoardRunRequestSchema = Schema.Struct({ id: Id, nodeId: Id, task: Schema.String });
export const BoardRunRequestRecordSchema = Schema.Struct({
  id: Id,
  fromId: Id,
  toId: Id,
  from: Schema.String,
  to: Schema.String,
  at: Schema.String,
  task: Schema.String,
  input: Schema.optionalKey(Schema.Unknown),
  status: Schema.Literals(["pending", "returned", "denied", "dropped", "failed", "stopped"]),
  returnedAt: Schema.optionalKey(Schema.String),
  returnSummary: Schema.optionalKey(Schema.String),
  returnData: Schema.optionalKey(Schema.Unknown),
  failureReason: Schema.optionalKey(Schema.String),
});
export const BoardWorkflowSettingsSchema = Schema.Struct({
  defaultInstanceId: Schema.String,
  defaultModel: Schema.String,
  runtimeMode: RuntimeMode,
  maxHandoffsPerEdge: Schema.NullOr(NonNegativeInt),
  waitPolicy: Schema.optionalKey(Schema.Literals(["allSettled", "failFast"])),
});
export const BoardRunSchema = Schema.Struct({
  id: Id,
  nodeId: Id,
  nodeName: Schema.String,
  task: Schema.String,
  status: Schema.Literals(["running", "stopping", "finished", "stopped", "failed"]),
  startedAt: Schema.String,
  endedAt: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
  requests: Schema.Array(BoardRunRequestRecordSchema),
  threads: Schema.Record(
    Schema.String,
    Schema.Struct({
      environmentId: EnvironmentId,
      projectId: ProjectId,
      threadId: ThreadId,
      seeded: Schema.Boolean,
    }),
  ),
  definition: Schema.Struct({
    nodes: Schema.Array(BoardNodeSchema),
    edges: Schema.Array(BoardEdgeSchema),
    settings: BoardWorkflowSettingsSchema,
  }),
  /** Its chats carry into the schedule's next run, so they are compacted once it ends. */
  compactAfter: Schema.optionalKey(Schema.Boolean),
});
export const BoardKanbanPlacementSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export const BoardWorkflowSchema = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  workspaceId: Id,
  nodes: Schema.Array(BoardNodeSchema),
  edges: Schema.Array(BoardEdgeSchema),
  pending: Schema.Array(BoardPendingWakeSchema),
  log: Schema.Array(BoardLogEntrySchema),
  runQueue: Schema.Array(BoardRunRequestSchema),
  runs: Schema.Array(BoardRunSchema),
  settings: BoardWorkflowSettingsSchema,
  kanban: Schema.optionalKey(BoardKanbanPlacementSchema),
});
export const BoardPeerSchema = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  url: TrimmedNonEmptyString,
  status: Schema.Literals(["connected", "disconnected", "connecting", "error"]),
  error: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
});
export type BoardPeer = typeof BoardPeerSchema.Type;
/** Each scheduled run starts new chats, or continues the previous scheduled run's chats. */
export const BoardScheduleChats = Schema.Literals(["new", "continue"]);
export type BoardScheduleChats = typeof BoardScheduleChats.Type;
/** A workflow's own schedule, run by the hub; it stops once `runCount` reaches `maxRuns`. */
export const BoardScheduleSchema = Schema.Struct({
  id: Id,
  workflowId: Id,
  task: TrimmedNonEmptyString,
  timing: BoardTimingSchema,
  maxRuns: Schema.optionalKey(PositiveInt),
  runCount: NonNegativeInt,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(Schema.String),
  /** Absent: "new". */
  chats: Schema.optionalKey(BoardScheduleChats),
});
export type BoardSchedule = typeof BoardScheduleSchema.Type;

// The sequence and snapshot must be read atomically so clients can resume events without a gap.
export const BoardSnapshotSchema = Schema.Struct({
  sequence: NonNegativeInt,
  workspaces: Schema.Array(BoardWorkspaceSchema),
  workflows: Schema.Array(BoardWorkflowSchema),
  kanban: Schema.Array(
    Schema.Struct({ workflowId: Id, cards: Schema.Array(BoardKanbanCardSchema) }),
  ),
  peers: Schema.Array(BoardPeerSchema),
  schedules: Schema.Array(BoardScheduleSchema),
});
export type BoardSnapshot = typeof BoardSnapshotSchema.Type;

export const BoardEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("workspace.upserted"),
    sequence: NonNegativeInt,
    workspace: BoardWorkspaceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("workspace.deleted"),
    sequence: NonNegativeInt,
    workspaceId: Id,
  }),
  Schema.Struct({
    kind: Schema.Literal("kanban.upserted"),
    sequence: NonNegativeInt,
    workflowId: Id,
    card: BoardKanbanCardSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("kanban.deleted"),
    sequence: NonNegativeInt,
    workflowId: Id,
    cardId: Id,
  }),
  Schema.Struct({
    kind: Schema.Literal("workflow.upserted"),
    sequence: NonNegativeInt,
    workflow: BoardWorkflowSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("workflow.deleted"),
    sequence: NonNegativeInt,
    workflowId: Id,
  }),
  Schema.Struct({
    kind: Schema.Literal("peer.upserted"),
    sequence: NonNegativeInt,
    peer: BoardPeerSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("peer.deleted"), sequence: NonNegativeInt, peerId: Id }),
  Schema.Struct({
    kind: Schema.Literal("run.upserted"),
    sequence: NonNegativeInt,
    workflowId: Id,
    run: BoardRunSchema,
    pending: Schema.optionalKey(Schema.Array(BoardPendingWakeSchema)),
  }),
  Schema.Struct({
    kind: Schema.Literal("schedule.upserted"),
    sequence: NonNegativeInt,
    schedule: BoardScheduleSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("schedule.deleted"),
    sequence: NonNegativeInt,
    scheduleId: Id,
  }),
]);
export type BoardEvent = typeof BoardEvent.Type;
export const BoardEventsQuery = Schema.Struct({
  afterSequence: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type BoardEventsQuery = typeof BoardEventsQuery.Type;

export class BoardInvalidRequestError extends Schema.TaggedError<BoardInvalidRequestError>()(
  "BoardInvalidRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class BoardNotFoundError extends Schema.TaggedError<BoardNotFoundError>()(
  "BoardNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}
export class BoardConflictError extends Schema.TaggedError<BoardConflictError>()(
  "BoardConflictError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}
/** The agent's machine could not be reached, so nothing was changed there. */
export class BoardMachineUnavailableError extends Schema.TaggedError<BoardMachineUnavailableError>()(
  "BoardMachineUnavailableError",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}
export class BoardInternalError extends Schema.TaggedError<BoardInternalError>()(
  "BoardInternalError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}
const Errors = [
  BoardInvalidRequestError,
  EnvironmentScopeRequiredError,
  BoardNotFoundError,
  BoardConflictError,
  BoardMachineUnavailableError,
  BoardInternalError,
] as const;
const WorkflowParams = Schema.Struct({ workflowId: Id });
const NodeParams = Schema.Struct({ workflowId: Id, nodeId: Id });
const EdgeParams = Schema.Struct({ workflowId: Id, fromId: Id, toId: Id });
const RunParams = Schema.Struct({ workflowId: Id, runId: Id });
const WorkspaceParams = Schema.Struct({ workspaceId: Id });
const FolderParams = Schema.Struct({ workspaceId: Id, environmentId: EnvironmentId });
const PeerParams = Schema.Struct({ peerId: Id });
const ScheduleParams = Schema.Struct({ scheduleId: Id });

export const BoardCreateWorkspaceInput = Schema.Struct({ id: Id, name: TrimmedNonEmptyString });
/** `removeFolders` lists the exact folders the user confirmed; only those are deleted from disk. */
export const BoardDeleteWorkspaceInput = Schema.Struct({
  removeFolders: Schema.optionalKey(
    Schema.Array(Schema.Struct({ environmentId: EnvironmentId, path: Schema.String })),
  ),
});
export type BoardDeleteWorkspaceInput = typeof BoardDeleteWorkspaceInput.Type;
export const BoardUpdateWorkspaceInput = Schema.Struct({ name: TrimmedNonEmptyString });
/** Without `path` the folder is `~/t3-workspaces/<workspace name>` on that machine. */
export const BoardAddFolderInput = Schema.Struct({
  environmentId: EnvironmentId,
  path: Schema.optionalKey(TrimmedNonEmptyString),
});
export const BoardCreateWorkflowInput = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  workspaceId: Id,
  settings: Schema.optionalKey(BoardWorkflowSettingsSchema),
});
export const BoardUpdateWorkflowInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  settings: Schema.optionalKey(BoardWorkflowSettingsSchema),
  /** Puts the kanban on the board or moves it; null takes it off. */
  kanban: Schema.optionalKey(Schema.NullOr(BoardKanbanPlacementSchema)),
});
export const BoardCreateNodeInput = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  profile: BoardAgentProfileSchema,
  environmentId: EnvironmentId,
  modelSelection: ModelSelection,
  prompt: Schema.optionalKey(Schema.String),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  size: Schema.optionalKey(Schema.Number),
  x: Schema.Number,
  y: Schema.Number,
});
/** The settings the chat had when "/new" moved it to a fresh thread; unset ones come from the node. */
export const BoardNewNodeChatInput = Schema.Struct({
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
export type BoardNewNodeChatInput = typeof BoardNewNodeChatInput.Type;
export const BoardUpdateNodeInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  profile: Schema.optionalKey(BoardAgentProfileSchema),
  environmentId: Schema.optionalKey(EnvironmentId),
  modelSelection: Schema.optionalKey(ModelSelection),
  prompt: Schema.optionalKey(Schema.String),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  size: Schema.optionalKey(Schema.Number),
  x: Schema.optionalKey(Schema.Number),
  y: Schema.optionalKey(Schema.Number),
});
/** What happens to the agent's chat before each firing sends the prompt into it. */
export const BoardNodeScheduleBeforeRun = Schema.Literals(["compact", "new_thread", "none"]);
export type BoardNodeScheduleBeforeRun = typeof BoardNodeScheduleBeforeRun.Type;
/** `runs` more firings from now (none: no limit); each sends `prompt` into the agent's chat. */
export const BoardSaveNodeScheduleInput = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  timing: BoardTimingSchema,
  runs: Schema.optionalKey(BoardScheduleRuns),
  beforeRun: BoardNodeScheduleBeforeRun,
});
export type BoardSaveNodeScheduleInput = typeof BoardSaveNodeScheduleInput.Type;
export const BoardSetNodeScheduleEnabledInput = Schema.Struct({ enabled: Schema.Boolean });
export const BoardPairPeerInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  pairingUrlOrCode: TrimmedNonEmptyString,
  host: Schema.optionalKey(TrimmedNonEmptyString),
});
export const BoardStartRunInput = Schema.Struct({
  id: Id,
  task: TrimmedNonEmptyString,
});
export const BoardCreateScheduleInput = Schema.Struct({
  id: Id,
  workflowId: Id,
  task: TrimmedNonEmptyString,
  timing: BoardTimingSchema,
  runs: Schema.optionalKey(BoardScheduleRuns),
  enabled: Schema.Boolean,
  chats: Schema.optionalKey(BoardScheduleChats),
});
/** `runs` counts from now; null removes the limit. */
export const BoardUpdateScheduleInput = Schema.Struct({
  task: Schema.optionalKey(TrimmedNonEmptyString),
  timing: Schema.optionalKey(BoardTimingSchema),
  runs: Schema.optionalKey(Schema.NullOr(BoardScheduleRuns)),
  enabled: Schema.optionalKey(Schema.Boolean),
  chats: Schema.optionalKey(BoardScheduleChats),
});

export type BoardCreateWorkflowInput = typeof BoardCreateWorkflowInput.Type;
export type BoardUpdateWorkflowInput = typeof BoardUpdateWorkflowInput.Type;
export type BoardCreateWorkspaceInput = typeof BoardCreateWorkspaceInput.Type;
export type BoardUpdateWorkspaceInput = typeof BoardUpdateWorkspaceInput.Type;
export type BoardAddFolderInput = typeof BoardAddFolderInput.Type;
export type BoardCreateNodeInput = typeof BoardCreateNodeInput.Type;
export type BoardUpdateNodeInput = typeof BoardUpdateNodeInput.Type;
export type BoardPairPeerInput = typeof BoardPairPeerInput.Type;
export type BoardStartRunInput = typeof BoardStartRunInput.Type;
export type BoardCreateScheduleInput = typeof BoardCreateScheduleInput.Type;
export type BoardUpdateScheduleInput = typeof BoardUpdateScheduleInput.Type;

export class BoardHttpGroup extends HttpApiGroup.make("board")
  .add(
    HttpApiEndpoint.get("getSnapshot", "/snapshot", {
      headers: OptionalAuthHeaders,
      success: BoardSnapshotSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listWorkspaces", "/workspaces", {
      headers: OptionalAuthHeaders,
      success: Schema.Array(BoardWorkspaceSchema),
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createWorkspace", "/workspaces", {
      headers: OptionalAuthHeaders,
      payload: BoardCreateWorkspaceInput,
      success: BoardWorkspaceSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkspace", "/workspaces/:workspaceId", {
      headers: OptionalAuthHeaders,
      params: WorkspaceParams,
      success: BoardWorkspaceSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateWorkspace", "/workspaces/:workspaceId", {
      headers: OptionalAuthHeaders,
      params: WorkspaceParams,
      payload: BoardUpdateWorkspaceInput,
      success: BoardWorkspaceSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteWorkspace", "/workspaces/:workspaceId/delete", {
      headers: OptionalAuthHeaders,
      params: WorkspaceParams,
      payload: BoardDeleteWorkspaceInput,
      success: HttpApiSchema.NoContent,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("addFolder", "/workspaces/:workspaceId/folders", {
      headers: OptionalAuthHeaders,
      params: WorkspaceParams,
      payload: BoardAddFolderInput,
      success: BoardWorkspaceSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteFolder", "/workspaces/:workspaceId/folders/:environmentId/delete", {
      headers: OptionalAuthHeaders,
      params: FolderParams,
      success: BoardWorkspaceSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listWorkflows", "/workflows", {
      headers: OptionalAuthHeaders,
      success: Schema.Array(BoardWorkflowSchema),
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createWorkflow", "/workflows", {
      headers: OptionalAuthHeaders,
      payload: BoardCreateWorkflowInput,
      success: BoardWorkflowSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkflow", "/workflows/:workflowId", {
      headers: OptionalAuthHeaders,
      params: WorkflowParams,
      success: BoardWorkflowSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateWorkflow", "/workflows/:workflowId", {
      headers: OptionalAuthHeaders,
      params: WorkflowParams,
      payload: BoardUpdateWorkflowInput,
      success: BoardWorkflowSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteWorkflow", "/workflows/:workflowId/delete", {
      headers: OptionalAuthHeaders,
      params: WorkflowParams,
      success: HttpApiSchema.NoContent,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createNode", "/workflows/:workflowId/nodes", {
      headers: OptionalAuthHeaders,
      params: WorkflowParams,
      payload: BoardCreateNodeInput,
      success: BoardNodeSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateNode", "/workflows/:workflowId/nodes/:nodeId", {
      headers: OptionalAuthHeaders,
      params: NodeParams,
      payload: BoardUpdateNodeInput,
      success: BoardNodeSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("openNodeChat", "/workflows/:workflowId/nodes/:nodeId/chat", {
      headers: OptionalAuthHeaders,
      params: NodeParams,
      success: BoardNodeSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("newNodeChat", "/workflows/:workflowId/nodes/:nodeId/chat/new", {
      headers: OptionalAuthHeaders,
      params: NodeParams,
      payload: BoardNewNodeChatInput,
      success: BoardNodeSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("saveNodeSchedule", "/workflows/:workflowId/nodes/:nodeId/schedule", {
      headers: OptionalAuthHeaders,
      params: NodeParams,
      payload: BoardSaveNodeScheduleInput,
      success: BoardNodeSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "setNodeScheduleEnabled",
      "/workflows/:workflowId/nodes/:nodeId/schedule/enabled",
      {
        headers: OptionalAuthHeaders,
        params: NodeParams,
        payload: BoardSetNodeScheduleEnabledInput,
        success: HttpApiSchema.NoContent,
        error: Errors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("syncNodeSchedule", "/workflows/:workflowId/nodes/:nodeId/schedule/sync", {
      headers: OptionalAuthHeaders,
      params: NodeParams,
      success: HttpApiSchema.NoContent,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "deleteNodeSchedule",
      "/workflows/:workflowId/nodes/:nodeId/schedule/delete",
      {
        headers: OptionalAuthHeaders,
        params: NodeParams,
        success: HttpApiSchema.NoContent,
        error: Errors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("deleteNode", "/workflows/:workflowId/nodes/:nodeId/delete", {
      headers: OptionalAuthHeaders,
      params: NodeParams,
      success: HttpApiSchema.NoContent,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createEdge", "/workflows/:workflowId/edges", {
      headers: OptionalAuthHeaders,
      params: WorkflowParams,
      payload: BoardEdgeSchema,
      success: BoardEdgeSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteEdge", "/workflows/:workflowId/edges/:fromId/:toId/delete", {
      headers: OptionalAuthHeaders,
      params: EdgeParams,
      success: HttpApiSchema.NoContent,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listPeers", "/peers", {
      headers: OptionalAuthHeaders,
      success: Schema.Array(BoardPeerSchema),
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("pairPeer", "/peers", {
      headers: OptionalAuthHeaders,
      payload: BoardPairPeerInput,
      success: BoardPeerSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("deletePeer", "/peers/:peerId/delete", {
      headers: OptionalAuthHeaders,
      params: PeerParams,
      success: HttpApiSchema.NoContent,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listRuns", "/workflows/:workflowId/runs", {
      headers: OptionalAuthHeaders,
      params: WorkflowParams,
      success: Schema.Array(BoardRunSchema),
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("startRun", "/workflows/:workflowId/runs", {
      headers: OptionalAuthHeaders,
      params: WorkflowParams,
      payload: BoardStartRunInput,
      success: BoardRunSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRun", "/workflows/:workflowId/runs/:runId", {
      headers: OptionalAuthHeaders,
      params: RunParams,
      success: BoardRunSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("stopRun", "/workflows/:workflowId/runs/:runId/stop", {
      headers: OptionalAuthHeaders,
      params: RunParams,
      success: BoardRunSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listSchedules", "/schedules", {
      headers: OptionalAuthHeaders,
      success: Schema.Array(BoardScheduleSchema),
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createSchedule", "/schedules", {
      headers: OptionalAuthHeaders,
      payload: BoardCreateScheduleInput,
      success: BoardScheduleSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateSchedule", "/schedules/:scheduleId", {
      headers: OptionalAuthHeaders,
      params: ScheduleParams,
      payload: BoardUpdateScheduleInput,
      success: BoardScheduleSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteSchedule", "/schedules/:scheduleId/delete", {
      headers: OptionalAuthHeaders,
      params: ScheduleParams,
      success: HttpApiSchema.NoContent,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getKanban", "/workflows/:workflowId/kanban", {
      headers: OptionalAuthHeaders,
      params: WorkflowParams,
      success: Schema.Array(BoardKanbanCardSchema),
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("events", "/events", {
      headers: OptionalAuthHeaders,
      query: BoardEventsQuery,
      success: HttpApiSchema.StreamSse({ data: BoardEvent }),
      error: Errors,
    }),
  )
  .prefix("/api/board")
  .middleware(EnvironmentAuthenticatedAuth) {}

export class BoardHttpApi extends HttpApi.make("board").add(BoardHttpGroup) {}
