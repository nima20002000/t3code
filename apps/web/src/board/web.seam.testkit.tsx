import { createMemoryHistory } from "@tanstack/react-router";
import {
  type Workflow,
  type KanbanPlacement,
  createWorkflow,
} from "@t3tools/board-core/boardModel";
import type { BoardEvent } from "@t3tools/board-core/http";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "@xyflow/react";
import "~/index.css";
import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { render } from "../../test/render";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
} from "../../test/fakeEnvironment";

/** The app on its board, served one seam workflow by a fake board API that records its posts. */
export async function openBoard(options: { readonly empty?: boolean } = {}) {
  const thread = threadWithHistory("board-seam-thread", 1);
  // The threads "/new" moves Scout to, one per use.
  const fresh = [1, 2, 3].map((n) => threadWithHistory(`board-seam-new-${n}`, 1));
  await using stack = new AsyncDisposableStack();
  stack.use(installFakeEnvironment([thread, ...fresh]));
  const previousFetch = globalThis.fetch;
  const previousBoard = localStorage.getItem("t3.board.v2");
  localStorage.removeItem("t3.board.v2");
  localStorage.removeItem("board-windows:board-seam");
  stack.defer(() => {
    globalThis.fetch = previousFetch;
    if (previousBoard === null) localStorage.removeItem("t3.board.v2");
    else localStorage.setItem("t3.board.v2", previousBoard);
  });
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" };
  const remoteEnvironmentId = EnvironmentId.make("remote-environment");
  const nodes = [
    {
      id: "scout",
      name: "Scout",
      profile: "orchestrator" as const,
      environmentId: ENVIRONMENT_ID,
      modelSelection,
      x: 40,
      y: 40,
    },
    {
      id: "remote",
      name: "Remote agent",
      profile: "worker" as const,
      environmentId: remoteEnvironmentId,
      modelSelection,
      x: 340,
      y: 40,
    },
  ];
  const base = createWorkflow("board-seam", "Seam workflow", "workspace");
  let workflow: Workflow = {
    ...base,
    nodes,
    // Each node's thread is the one its newest run launched.
    runs: [
      {
        id: "run",
        nodeId: "scout",
        nodeName: "Scout",
        task: "task",
        status: "finished" as const,
        startedAt: "2026-01-01T00:00:00.000Z",
        requests: [],
        threads: {
          scout: {
            environmentId: ENVIRONMENT_ID,
            projectId: ProjectId.make("board-seam-project"),
            threadId: thread.id,
            seeded: true,
          },
          remote: {
            environmentId: remoteEnvironmentId,
            projectId: ProjectId.make("remote-project"),
            threadId: ThreadId.make("remote-thread"),
            seeded: true,
          },
        },
        definition: { nodes, edges: [], settings: base.settings },
      },
    ],
    // Put on the board far from the agents, as if by a viewer on a much larger screen.
    kanban: { x: 1500, y: 1100, width: 700, height: 300 },
  };
  if (options.empty) workflow = base;
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sequence = 0;
  const emit = (event: BoardEvent) => {
    sequence += 1;
    if (event.kind === "workflow.upserted") workflow = event.workflow;
    eventController?.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify({ ...event, sequence })}\n\n`),
    );
  };
  // The board calls the app asked for, besides loading and following the board.
  const posts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if ((input instanceof Request ? input.method : init?.method) === "POST") {
      posts.push(url.pathname);
      const nodeId = url.pathname.match(
        /^\/api\/board\/workflows\/board-seam\/nodes\/([^/]+)$/,
      )?.[1];
      if (nodeId) {
        const patch = JSON.parse(await new Request(input, init).text()) as Partial<
          Workflow["nodes"][number]
        >;
        const node = { ...workflow.nodes.find((entry) => entry.id === nodeId)!, ...patch };
        workflow = {
          ...workflow,
          nodes: workflow.nodes.map((entry) => (entry.id === nodeId ? node : entry)),
        };
        emit({ kind: "workflow.upserted", sequence, workflow });
        return Response.json(node);
      }
      if (url.pathname === "/api/board/workflows/board-seam") {
        // Like the server: the kanban is placed, moved or taken off and every viewer hears of it.
        const body = await new Request(input, init).text();
        const { kanban } = JSON.parse(body) as { kanban: KanbanPlacement | null };
        const { kanban: _old, ...rest } = workflow;
        const next = kanban ? { ...rest, kanban } : rest;
        workflow = next;
        emit({ kind: "workflow.upserted", sequence, workflow: next });
        return Response.json(next);
      }
      if (url.pathname.endsWith("/chat/new")) {
        // Like the server: Scout's chat moves to a new thread, newer than its run's.
        const uses = posts.filter((path) => path === url.pathname).length;
        const next = fresh[uses - 1]!;
        const scout = {
          ...nodes[0]!,
          chat: {
            environmentId: ENVIRONMENT_ID,
            projectId: ProjectId.make("board-seam-project"),
            threadId: next.id,
            startedAt: `2026-02-0${uses}T00:00:00.000Z`,
          },
        };
        emit({
          kind: "workflow.upserted",
          sequence,
          workflow: { ...workflow, nodes: [scout, ...nodes.slice(1)] },
        });
        return Response.json(scout);
      }
    }
    if (url.pathname === "/api/board/snapshot") {
      return Response.json({
        sequence: 0,
        workspaces: [{ id: "workspace", name: "Workspace", folders: [] }],
        workflows: [workflow],
        kanban: [
          {
            workflowId: "board-seam",
            cards: [
              {
                id: "card",
                title: "Map the parser",
                body: "",
                status: "doing",
                updatedBy: "scout",
                updatedAt: "2026-01-01T00:00:00.000Z",
                runId: "run",
              },
            ],
          },
        ],
        peers: [
          {
            id: "remote-peer",
            name: "Remote machine",
            environmentId: "remote-environment",
            url: "https://remote.example",
            status: "connected",
          },
        ],
        schedules: [],
      });
    }
    if (url.pathname === "/api/board/events") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            eventController = controller;
          },
        }),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    return previousFetch(input, init);
  };
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px";
  // The app owns the router, including the real _chat route and shell.
  const screen = stack.use(await render(<AppRoot router={router} />, { container, router: false }));
  await expect.element(screen.getByText("Board", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByText("Board", { exact: true }));
  const owned = stack.move();
  return {
    screen,
    posts,
    workflow,
    emit,
    following: () => eventController !== undefined,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
