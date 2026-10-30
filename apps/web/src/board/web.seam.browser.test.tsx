import { createMemoryHistory } from "@tanstack/react-router";
import { createWorkflow } from "@t3tools/board-core/boardModel";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
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
  type FakeDriver,
} from "../../test/fakeEnvironment";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

/** The app on its board, served one seam workflow by a fake board API that records its posts. */
async function openBoard() {
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
  const workflow = {
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
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sequence = 1;
  const emit = (event: object) =>
    eventController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  // The board calls the app asked for, besides loading and following the board.
  const posts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if ((input instanceof Request ? input.method : init?.method) === "POST") {
      posts.push(url.pathname);
      if (url.pathname === "/api/board/workflows/board-seam") {
        // Like the server: the kanban is placed, moved or taken off and every viewer hears of it.
        const body = await new Request(input, init).text();
        const { kanban } = JSON.parse(body) as { kanban: object | null };
        const { kanban: _old, ...rest } = workflow;
        const next = kanban ? { ...rest, kanban } : rest;
        sequence += 1;
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
        sequence += 1;
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

it("shows Board in the chat layout, swaps the thread list for the board sidebar and mounts the node's real ChatView, where /new starts a new thread, and keeps the kanban on the board", async () => {
  // One test: the board's HTTP client keeps the first fetch it sees, so a second test's fake board API would never be called.
  await using board = await openBoard();
  const { screen, workflow, emit } = board;
  const boardPosts = () => board.posts.filter((path) => path.startsWith("/api/board/"));
  await expect.element(screen.getByRole("navigation", { name: "Threads" })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Scout", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(board.following()).toBe(true));
  // The kanban kept far from the agents still opens in view, with its cards.
  const kanban = screen.getByRole("region", { name: "Kanban" });
  await expect.element(kanban.getByText("Map the parser")).toBeVisible();
  const inView = () => {
    const box = kanban.element().getBoundingClientRect();
    const canvas = document.querySelector(".board-canvas")!.getBoundingClientRect();
    return (
      box.left >= canvas.left &&
      box.top >= canvas.top &&
      box.right <= canvas.right &&
      box.bottom <= canvas.bottom
    );
  };
  await vi.waitFor(() => expect(inView()).toBe(true));
  emit({
    kind: "workflow.upserted",
    sequence: 1,
    workflow: { ...workflow, name: "Live workflow" },
  });
  await expect.element(screen.getByRole("button", { name: "Live workflow" }).first()).toBeVisible();
  await userEvent.hover(screen.getByText("Scout", { exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Open Scout thread" }));
  const panel = screen.getByRole("region", { name: "Scout chat" });
  await expect.element(panel).toBeVisible();
  await expect
    .element(panel.getByText("Answer 0 for board-seam-thread.", { exact: false }))
    .toBeVisible();
  // Full screen blurs the board while the chat grows to fill the window, then the blur clears.
  await userEvent.click(panel.getByRole("button", { name: "Full screen" }));
  await vi.waitFor(() => expect(document.querySelector(".board-panel-backdrop")).not.toBeNull());
  await vi.waitFor(() => {
    const chat = panel.element().getBoundingClientRect();
    expect([chat.width, chat.height]).toEqual([window.innerWidth, window.innerHeight]);
  });
  await vi.waitFor(() => expect(document.querySelector(".board-panel-backdrop")).toBeNull());
  await userEvent.click(panel.getByRole("button", { name: "Exit full screen" }));
  await expect.element(panel.getByRole("button", { name: "Full screen" })).toBeVisible();
  // "/new" starts the agent a new thread instead of sending: picked from the menu, or typed and
  // sent with Enter or the Send button.
  const composer = () => panel.element().querySelector<HTMLElement>("form [contenteditable=true]")!;
  const newChat = "/api/board/workflows/board-seam/nodes/scout/chat/new";

  await userEvent.click(composer());
  await userEvent.keyboard("/ne");
  // The menu renders outside the app's container; Enter picks its first match.
  await expect.element(page.getByRole("option", { name: /^\/new/ })).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(boardPosts()).toEqual([newChat]));
  await expect
    .element(panel.getByText("Answer 0 for board-seam-new-1.", { exact: false }))
    .toBeVisible();
  expect(composer().textContent).toBe("");

  await userEvent.keyboard("/new");
  await userEvent.keyboard("{Escape}{Enter}");
  await vi.waitFor(() => expect(boardPosts()).toEqual([newChat, newChat]));
  await expect
    .element(panel.getByText("Answer 0 for board-seam-new-2.", { exact: false }))
    .toBeVisible();
  await userEvent.keyboard("/new");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(panel.getByRole("button", { name: "Submit message" }));
  await vi.waitFor(() => expect(boardPosts()).toEqual([newChat, newChat, newChat]));
  await expect
    .element(panel.getByText("Answer 0 for board-seam-new-3.", { exact: false }))
    .toBeVisible();
  expect(panel.getByText("/new", { exact: true }).elements()).toEqual([]);
  await userEvent.click(panel.getByRole("button", { name: "Close Scout chat" }));
  await userEvent.hover(screen.getByText("Remote agent", { exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Open Remote agent thread" }));
  const remotePanel = screen.getByRole("region", { name: "Remote agent chat" });
  await expect
    .element(
      remotePanel.getByText("Connect Remote machine in Connections to view and use this thread."),
    )
    .toBeVisible();

  // Taken off the board and added back, for every viewer.
  const workflowPath = "/api/board/workflows/board-seam";
  await userEvent.click(kanban.getByRole("button", { name: "Remove kanban from board" }));
  await expect.element(kanban).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add kanban" }));
  await expect
    .element(screen.getByRole("region", { name: "Kanban" }).getByText("Map the parser"))
    .toBeVisible();
  await vi.waitFor(() => expect(inView()).toBe(true));
  expect(boardPosts().filter((path) => path === workflowPath)).toHaveLength(2);
  await expect.element(screen.getByRole("button", { name: "Show kanban" })).toBeVisible();
});
