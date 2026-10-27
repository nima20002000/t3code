import { createMemoryHistory } from "@tanstack/react-router";
import { createWorkflow } from "@t3tools/board-core/boardModel";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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

it("shows Board in the chat layout, hides the sidebar and mounts the node's real ChatView", async () => {
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
  const workflow = {
    ...createWorkflow("board-seam", "Seam workflow"),
    nodes: [
      {
        id: "scout",
        name: "Scout",
        environmentId: ENVIRONMENT_ID,
        threadId: thread.id,
        x: 40,
        y: 40,
        baselined: true,
      },
      {
        id: "remote",
        name: "Remote agent",
        environmentId: EnvironmentId.make("remote-environment"),
        threadId: ThreadId.make("remote-thread"),
        x: 340,
        y: 40,
        baselined: true,
      },
    ],
  };
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === "/api/board/snapshot") {
      return Response.json({
        sequence: 0,
        workflows: [workflow],
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
  await expect.element(screen.getByText("Live workflow", { exact: true })).toBeVisible();
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
