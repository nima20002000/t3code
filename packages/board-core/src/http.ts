import {
  EnvironmentAuthenticatedAuth,
  EnvironmentId,
  EnvironmentScopeRequiredError,
  ModelSelection,
  NonNegativeInt,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  PositiveInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

const Id = TrimmedNonEmptyString;
const OptionalAuthHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

export const BoardNodeSchema = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  projectId: Schema.optionalKey(ProjectId),
  threadId: ThreadId,
  x: Schema.Number,
  y: Schema.Number,
  baselined: Schema.Boolean,
  awaitingFirstReply: Schema.optionalKey(Schema.Boolean),
  role: Schema.optionalKey(Schema.String),
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
  status: Schema.Literals(["pending", "returned", "denied", "dropped"]),
  returnedAt: Schema.optionalKey(Schema.String),
  returnSummary: Schema.optionalKey(Schema.String),
  returnData: Schema.optionalKey(Schema.Unknown),
});
export const BoardRunSchema = Schema.Struct({
  id: Id,
  nodeId: Id,
  nodeName: Schema.String,
  task: Schema.String,
  status: Schema.Literals(["running", "finished", "stopped", "failed"]),
  startedAt: Schema.String,
  endedAt: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
  requests: Schema.Array(BoardRunRequestRecordSchema),
});
export const BoardWorkflowSettingsSchema = Schema.Struct({
  defaultInstanceId: Schema.String,
  defaultModel: Schema.String,
  runtimeMode: RuntimeMode,
  maxHandoffsPerEdge: Schema.NullOr(NonNegativeInt),
  waitPolicy: Schema.optionalKey(Schema.Literals(["allSettled", "failFast"])),
});
export const BoardWorkflowSchema = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  nodes: Schema.Array(BoardNodeSchema),
  edges: Schema.Array(BoardEdgeSchema),
  pending: Schema.Array(BoardPendingWakeSchema),
  log: Schema.Array(BoardLogEntrySchema),
  runQueue: Schema.Array(BoardRunRequestSchema),
  runs: Schema.Array(BoardRunSchema),
  settings: BoardWorkflowSettingsSchema,
});
export const BoardPeerSchema = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  url: TrimmedNonEmptyString,
  status: Schema.Literals(["connected", "disconnected", "connecting", "error"]),
  error: Schema.optionalKey(Schema.String),
});
export type BoardPeer = typeof BoardPeerSchema.Type;
export const BoardScheduleSchema = Schema.Struct({
  id: Id,
  workflowId: Id,
  nodeId: Id,
  task: TrimmedNonEmptyString,
  everyMs: PositiveInt,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(Schema.String),
});
export type BoardSchedule = typeof BoardScheduleSchema.Type;

// The sequence and snapshot must be read atomically so clients can resume events without a gap.
export const BoardSnapshotSchema = Schema.Struct({
  sequence: NonNegativeInt,
  workflows: Schema.Array(BoardWorkflowSchema),
  peers: Schema.Array(BoardPeerSchema),
  schedules: Schema.Array(BoardScheduleSchema),
});
export type BoardSnapshot = typeof BoardSnapshotSchema.Type;

export const BoardEvent = Schema.Union([
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
  BoardInternalError,
] as const;
const WorkflowParams = Schema.Struct({ workflowId: Id });
const NodeParams = Schema.Struct({ workflowId: Id, nodeId: Id });
const EdgeParams = Schema.Struct({ workflowId: Id, fromId: Id, toId: Id });
const RunParams = Schema.Struct({ workflowId: Id, runId: Id });
const PeerParams = Schema.Struct({ peerId: Id });
const ScheduleParams = Schema.Struct({ scheduleId: Id });

export const BoardCreateWorkflowInput = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  settings: Schema.optionalKey(BoardWorkflowSettingsSchema),
});
export const BoardUpdateWorkflowInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  settings: Schema.optionalKey(BoardWorkflowSettingsSchema),
});
export const BoardImportWorkflowsInput = Schema.Struct({
  workflows: Schema.Array(BoardWorkflowSchema),
});
export const BoardCreateNodeInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("bind"),
    id: Id,
    name: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    x: Schema.Number,
    y: Schema.Number,
    role: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("launch"),
    id: Id,
    name: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
    x: Schema.Number,
    y: Schema.Number,
    role: Schema.optionalKey(Schema.String),
  }),
]);
export const BoardUpdateNodeInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  role: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.Number),
  y: Schema.optionalKey(Schema.Number),
});
export const BoardPairPeerInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  pairingUrlOrCode: TrimmedNonEmptyString,
});
export const BoardStartRunInput = Schema.Struct({
  id: Id,
  nodeId: Id,
  task: TrimmedNonEmptyString,
});
export const BoardCreateScheduleInput = Schema.Struct({
  id: Id,
  workflowId: Id,
  nodeId: Id,
  task: TrimmedNonEmptyString,
  everyMs: PositiveInt,
  enabled: Schema.Boolean,
});
export const BoardUpdateScheduleInput = Schema.Struct({
  nodeId: Schema.optionalKey(Id),
  task: Schema.optionalKey(TrimmedNonEmptyString),
  everyMs: Schema.optionalKey(PositiveInt),
  enabled: Schema.optionalKey(Schema.Boolean),
});

export type BoardCreateWorkflowInput = typeof BoardCreateWorkflowInput.Type;
export type BoardUpdateWorkflowInput = typeof BoardUpdateWorkflowInput.Type;
export type BoardImportWorkflowsInput = typeof BoardImportWorkflowsInput.Type;
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
    HttpApiEndpoint.post("importWorkflows", "/workflows/import", {
      headers: OptionalAuthHeaders,
      payload: BoardImportWorkflowsInput,
      success: Schema.Array(BoardWorkflowSchema),
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
    HttpApiEndpoint.patch("updateWorkflow", "/workflows/:workflowId", {
      headers: OptionalAuthHeaders,
      params: WorkflowParams,
      payload: BoardUpdateWorkflowInput,
      success: BoardWorkflowSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteWorkflow", "/workflows/:workflowId", {
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
    HttpApiEndpoint.patch("updateNode", "/workflows/:workflowId/nodes/:nodeId", {
      headers: OptionalAuthHeaders,
      params: NodeParams,
      payload: BoardUpdateNodeInput,
      success: BoardNodeSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteNode", "/workflows/:workflowId/nodes/:nodeId", {
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
    HttpApiEndpoint.delete("deleteEdge", "/workflows/:workflowId/edges/:fromId/:toId", {
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
    HttpApiEndpoint.delete("deletePeer", "/peers/:peerId", {
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
    HttpApiEndpoint.patch("updateSchedule", "/schedules/:scheduleId", {
      headers: OptionalAuthHeaders,
      params: ScheduleParams,
      payload: BoardUpdateScheduleInput,
      success: BoardScheduleSchema,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteSchedule", "/schedules/:scheduleId", {
      headers: OptionalAuthHeaders,
      params: ScheduleParams,
      success: HttpApiSchema.NoContent,
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
