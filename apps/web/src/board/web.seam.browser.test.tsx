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

it("shows Board in the chat layout, swaps the thread list for the board sidebar and mounts the node's real ChatView", async () => {
  const thread = threadWithHistory("board-seam-thread", 1);
  using _environment = installFakeEnvironment([thread]);
  const previousFetch = globalThis.fetch;
  const previousBoard = localStorage.getItem("t3.board.v2");
  localStorage.removeItem("t3.board.v2");
  using _cleanup = {
    [Symbol.dispose]() {
      globalThis.fetch = previousFetch;
      if (previousBoard === null) localStorage.removeItem("t3.board.v2");
      else localStorage.setItem("t3.board.v2", previousBoard);
    },
  };
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
  };
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === "/api/board/snapshot") {
      return Response.json({
        sequence: 0,
        workspaces: [{ id: "workspace", name: "Workspace", folders: [] }],
        workflows: [workflow],
        kanban: [],
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
  await using screen = await render(<AppRoot router={router} />, { container, router: false });
  await expect.element(screen.getByText("Board", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByText("Board", { exact: true }));
  await expect.element(screen.getByRole("navigation", { name: "Threads" })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Scout", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(eventController).toBeDefined());
  eventController?.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ kind: "workflow.upserted", sequence: 1, workflow: { ...workflow, name: "Live workflow" } })}\n\n`,
    ),
  );
  await expect.element(screen.getByRole("button", { name: "Live workflow" }).first()).toBeVisible();
  await userEvent.hover(screen.getByText("Scout", { exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Scout settings" }));
  const panel = screen.getByRole("complementary", { name: "Scout settings" });
  await expect.element(panel).toBeVisible();
  await expect
    .element(panel.getByText("Answer 0 for board-seam-thread.", { exact: false }))
    .toBeVisible();
  await userEvent.click(panel.getByRole("button", { name: "Close" }));
  await userEvent.hover(screen.getByText("Remote agent", { exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Remote agent settings" }));
  const remotePanel = screen.getByRole("complementary", { name: "Remote agent settings" });
  await expect
    .element(
      remotePanel.getByText("Connect Remote machine in Connections to view and use this thread."),
    )
    .toBeVisible();
});
