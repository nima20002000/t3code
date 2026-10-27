import {
  BoardHttpApi,
  BoardInternalError,
  BoardNotFoundError,
  type NodeDriverError,
} from "@t3tools/board-core";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type { SqlError } from "effect/sql/SqlError";
import * as BoardScheduler from "./BoardScheduler.ts";
import * as BoardPeers from "./BoardPeers.ts";
import * as BoardService from "./BoardService.ts";
import * as BoardStore from "./BoardStore.ts";
import * as DriverRegistry from "./DriverRegistry.ts";
import * as TaskEngine from "./TaskEngine.ts";
import type { BoardConflictError, BoardInvalidRequestError } from "@t3tools/board-core";
import { AuthHttp } from "./upstream.ts";

type ServiceError =
  | SqlError
  | NodeDriverError
  | BoardConflictError
  | BoardInvalidRequestError
  | BoardNotFoundError
  | BoardInternalError;
const internalFailure = (cause: unknown) =>
  Effect.logError("Board request failed", { cause }).pipe(
    Effect.andThen(Effect.fail(new BoardInternalError({ message: "Board operation failed." }))),
  );
const mapFailures = <A, R>(effect: Effect.Effect<A, ServiceError, R>) =>
  effect.pipe(Effect.catchTags({ SqlError: internalFailure, NodeDriverError: internalFailure }));
const read = <A, R>(effect: Effect.Effect<A, ServiceError, R>) =>
  AuthHttp.requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
    Effect.andThen(mapFailures(effect)),
  );
const operate = <A, R>(effect: Effect.Effect<A, ServiceError, R>) =>
  AuthHttp.requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
    Effect.andThen(mapFailures(effect)),
  );

const handlers = HttpApiBuilder.group(
  BoardHttpApi,
  "board",
  Effect.fnUntraced(function* (handler) {
    const board = yield* BoardService.BoardService;
    const peers = yield* BoardPeers.BoardPeers;
    const store = yield* BoardStore.BoardStore;
    return handler
      .handle("getSnapshot", () => read(store.snapshot()))
      .handle("listWorkflows", () => read(board.listWorkflows()))
      .handle("getWorkflow", ({ params }) => read(board.getWorkflow(params.workflowId)))
      .handle("createWorkflow", ({ payload }) => operate(board.createWorkflow(payload)))
      .handle("importWorkflows", ({ payload }) => operate(board.importWorkflows(payload)))
      .handle("updateWorkflow", ({ params, payload }) =>
        operate(board.updateWorkflow(params.workflowId, payload)),
      )
      .handle("deleteWorkflow", ({ params }) => operate(board.deleteWorkflow(params.workflowId)))
      .handle("createNode", ({ params, payload }) =>
        operate(board.createNode(params.workflowId, payload)),
      )
      .handle("updateNode", ({ params, payload }) =>
        operate(board.updateNode(params.workflowId, params.nodeId, payload)),
      )
      .handle("deleteNode", ({ params }) =>
        operate(board.deleteNode(params.workflowId, params.nodeId)),
      )
      .handle("createEdge", ({ params, payload }) =>
        operate(board.createEdge(params.workflowId, payload)),
      )
      .handle("deleteEdge", ({ params }) =>
        operate(board.deleteEdge(params.workflowId, params.fromId, params.toId)),
      )
      .handle("listPeers", () => read(board.listPeers()))
      .handle("pairPeer", ({ payload }) => operate(peers.pair(payload)))
      .handle("deletePeer", ({ params }) => operate(peers.remove(params.peerId)))
      .handle("listRuns", ({ params }) =>
        read(board.getWorkflow(params.workflowId).pipe(Effect.map((workflow) => workflow.runs))),
      )
      .handle("startRun", ({ params, payload }) =>
        operate(board.startRun(params.workflowId, payload)),
      )
      .handle("getRun", ({ params }) =>
        read(
          board.getWorkflow(params.workflowId).pipe(
            Effect.flatMap((workflow) => {
              const run = workflow.runs.find((entry) => entry.id === params.runId);
              return run
                ? Effect.succeed(run)
                : Effect.fail(new BoardNotFoundError({ message: "Run not found." }));
            }),
          ),
        ),
      )
      .handle("stopRun", ({ params }) => operate(board.stopRun(params.workflowId, params.runId)))
      .handle("listSchedules", () => read(board.listSchedules()))
      .handle("createSchedule", ({ payload }) => operate(board.createSchedule(payload)))
      .handle("updateSchedule", ({ params, payload }) =>
        operate(board.updateSchedule(params.scheduleId, payload)),
      )
      .handle("deleteSchedule", ({ params }) => operate(board.deleteSchedule(params.scheduleId)))
      .handle("events", ({ query }) =>
        Effect.gen(function* () {
          yield* AuthHttp.requireEnvironmentScope(AuthOrchestrationReadScope);
          return store
            .events(query.afterSequence ?? 0)
            .pipe(
              Stream.catch((cause) =>
                Stream.fromEffect(Effect.logError("Board event stream failed", { cause })).pipe(
                  Stream.drain,
                ),
              ),
            );
        }),
      );
  }),
);

const services = Layer.mergeAll(BoardService.layer, BoardScheduler.layer, BoardPeers.layer).pipe(
  Layer.provideMerge(TaskEngine.layer),
  Layer.provideMerge(DriverRegistry.layer),
  Layer.provideMerge(BoardStore.layer),
);

export const layer = HttpApiBuilder.layer(BoardHttpApi).pipe(
  Layer.provide(handlers),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provide(services),
);
