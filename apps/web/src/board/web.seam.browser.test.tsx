import type * as Context from "effect/Context";
import type { FakeDriver } from "../../test/fakeEnvironment";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { openBoard } from "./web.seam.testkit";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it("shows Board in the chat layout, swaps the thread list for the board sidebar and mounts the node's real ChatView, where /new starts a new thread, and keeps the kanban on the board", async () => {
  // One test: the board's HTTP client keeps the first fetch it sees, so a second test's fake board API would never be called.
  await using board = await openBoard();
  const { screen, workflow, emit } = board;
  const windowPairing = "/api/board/peers/remote-peer/window-pairing";
  const boardPosts = () =>
    board.posts.filter((path) => path.startsWith("/api/board/") && path !== windowPairing);
  await expect.element(screen.getByRole("navigation", { name: "Threads" })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Scout", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(board.following()).toBe(true));
  // The window asks the hub, once, to let it into the paired machine it has not saved.
  await vi.waitFor(() =>
    expect(board.posts.filter((path) => path === windowPairing)).toHaveLength(1),
  );
  // The kanban kept far from the agents still opens in view, with its cards.
  const kanban = screen.getByRole("region", { name: "Kanban" });
  await expect.element(kanban.getByText("Map the parser")).toBeVisible();
  const inView = (element = kanban.element()) => {
    const box = element.getBoundingClientRect();
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
});
