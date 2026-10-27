import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  BoardCreateNodeInput,
  BoardEvent,
  BoardEventsQuery,
  BoardHttpApi,
  BoardPeerSchema,
  BoardRunRequestRecordSchema,
  BoardStartRunInput,
  BoardWorkflowSettingsSchema,
} from "./http.ts";

const decodeSyncBoardEvent = Schema.decodeSync(BoardEvent);
const decodeSyncBoardEventsQuery = Schema.decodeSync(BoardEventsQuery);
const decodeSyncBoardRunRequestRecordSchema = Schema.decodeSync(BoardRunRequestRecordSchema);
const decodeSyncBoardStartRunInput = Schema.decodeSync(BoardStartRunInput);
const decodeSyncBoardWorkflowSettingsSchema = Schema.decodeSync(BoardWorkflowSettingsSchema);
const decodeUnknownSyncBoardCreateNodeInput = Schema.decodeUnknownSync(BoardCreateNodeInput);
const decodeUnknownSyncBoardPeerSchema = Schema.decodeUnknownSync(BoardPeerSchema);

describe("board wire contract", () => {
  it("validates run, node, and cap input", () => {
    expect(() => decodeSyncBoardStartRunInput({ id: "r", task: "  " })).toThrow();
    expect(() =>
      decodeSyncBoardWorkflowSettingsSchema({
        defaultInstanceId: "codex",
        defaultModel: "gpt-6-luna",
        runtimeMode: "full-access",
        maxHandoffsPerEdge: -1,
      }),
    ).toThrow();
    expect(() =>
      decodeUnknownSyncBoardCreateNodeInput({
        id: "n",
        name: "Node",
        profile: "master",
        environmentId: "env",
        modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
        x: 0,
        y: 0,
      }),
    ).toThrow();
    expect(
      decodeUnknownSyncBoardCreateNodeInput({
        id: "n",
        name: "Node",
        profile: "orchestrator",
        environmentId: "env",
        modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
        x: 0,
        y: 0,
      }).profile,
    ).toBe("orchestrator");
  });

  it("represents failed and stopped child requests in a run", () => {
    const request = {
      id: "r",
      fromId: "a",
      toId: "b",
      from: "A",
      to: "B",
      at: "now",
      task: "work",
      failureReason: "interrupted",
    };
    expect(
      decodeSyncBoardRunRequestRecordSchema({ ...request, status: "failed" }).failureReason,
    ).toBe("interrupted");
    expect(decodeSyncBoardRunRequestRecordSchema({ ...request, status: "stopped" }).status).toBe(
      "stopped",
    );
  });

  it("keeps peer credentials out of the wire type and decodes events", () => {
    const peer = decodeUnknownSyncBoardPeerSchema({
      id: "p",
      name: "Peer",
      environmentId: "env",
      url: "https://example.com",
      status: "connected",
      bearer: "secret",
    });
    expect(peer).not.toHaveProperty("bearer");
    expect(decodeSyncBoardEvent({ kind: "peer.upserted", sequence: 1, peer })).toEqual({
      kind: "peer.upserted",
      sequence: 1,
      peer,
    });
    expect(() => decodeSyncBoardEvent({ kind: "peer.upserted", sequence: -1, peer })).toThrow();
  });

  it("decodes a resumable event cursor from the URL", () => {
    expect(decodeSyncBoardEventsQuery({ afterSequence: "12" })).toEqual({
      afterSequence: 12,
    });
    expect(() => decodeSyncBoardEventsQuery({ afterSequence: "-1" })).toThrow();
  });

  it("defines authenticated board routes including a typed event stream", () => {
    const endpoints = BoardHttpApi.groups.board.endpoints;
    expect(endpoints.getSnapshot.path).toBe("/api/board/snapshot");
    expect(endpoints.startRun.path).toBe("/api/board/workflows/:workflowId/runs");
    expect(endpoints.stopRun.path).toBe("/api/board/workflows/:workflowId/runs/:runId/stop");
    expect(endpoints.getKanban.path).toBe("/api/board/workflows/:workflowId/kanban");
    expect(endpoints.deleteWorkspace.path).toBe("/api/board/workspaces/:workspaceId/delete");
    expect(endpoints.events.path).toBe("/api/board/events");
    expect([...endpoints.events.success]).toEqual(
      expect.arrayContaining([expect.objectContaining({ _tag: "StreamSse", mode: "sse" })]),
    );
    expect(endpoints.events.middlewares.size).toBeGreaterThan(0);
  });
});

describe("BoardHttpApi methods", () => {
  it("uses only GET and POST, the methods t3's cross-origin policy allows the desktop window", () => {
    const methods = new Set(
      Object.values(BoardHttpApi.groups).flatMap((group) =>
        Object.values(group.endpoints).map((endpoint) => endpoint.method),
      ),
    );
    expect([...methods].toSorted()).toEqual(["GET", "POST"]);
  });
});
