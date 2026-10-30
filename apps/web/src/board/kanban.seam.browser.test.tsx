import type * as Context from "effect/Context";
import type { FakeDriver } from "../../test/fakeEnvironment";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { openBoard } from "./web.seam.testkit";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it("keeps kanban interaction, deletion and history scoped to the board", async () => {
  await using board = await openBoard();
  const { screen, workflow, emit } = board;
  const boardPosts = () => board.posts.filter((path) => path.startsWith("/api/board/"));
  await expect.element(screen.getByText("Scout", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(board.following()).toBe(true));
  const kanban = screen.getByRole("region", { name: "Kanban" });
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
    workflow: {
      ...workflow,
      name: "New chat",
      nodes: workflow.nodes.map((node) =>
        node.id === "scout"
          ? {
              ...node,
              chat: { ...workflow.runs[0]!.threads.scout!, startedAt: "2026-02-01T00:00:00.000Z" },
            }
          : node,
      ),
    },
  });
  await expect
    .element(screen.getByRole("button", { name: "New chat", exact: true }).first())
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Restore the board as it was when opened" }))
    .toBeDisabled();
  const scout = screen.getByText("Scout", { exact: true });
  const beforeNudge = scout.element().getBoundingClientRect().left;
  scout.element().closest<HTMLElement>(".react-flow__node")!.focus();
  await userEvent.keyboard("{Enter}{ArrowRight}");
  await vi.waitFor(() =>
    expect(scout.element().getBoundingClientRect().left).toBeGreaterThan(beforeNudge),
  );
  await expect.element(screen.getByRole("button", { name: "Undo (Ctrl+Z)" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Undo (Ctrl+Z)" }));
  await vi.waitFor(() => expect(scout.element().getBoundingClientRect().left).toBe(beforeNudge));
  emit({
    kind: "workflow.upserted",
    sequence: 1,
    workflow: { ...workflow, kanban: { x: 0, y: 400, width: 900, height: 800 } },
  });
  await userEvent.hover(screen.getByText("Scout", { exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Scout settings" }));
  const settings = screen.getByRole("region", { name: "Scout settings" });
  await vi.waitFor(() => expect(inView(settings.element())).toBe(true));
  await userEvent.click(settings.getByRole("button", { name: "Close Scout settings" }));
  // Sidebar keys do not delete a selected canvas object.
  await userEvent.click(screen.getByRole("button", { name: "Show kanban" }));
  await vi.waitFor(() => expect(inView()).toBe(true));
  await userEvent.click(kanban.getByText("Kanban", { exact: true }));
  screen.getByRole("button", { name: "Board", exact: true }).element().focus();
  await userEvent.keyboard("{Delete}");
  await expect.element(kanban).toBeVisible();

  const beforeButtonDrag = kanban.element().getBoundingClientRect().toJSON();
  const button = kanban.getByRole("button", { name: "Remove kanban from board" }).element();
  const rect = button.getBoundingClientRect();
  const mouse = (type: string, dx: number, dy: number) =>
    new MouseEvent(type, {
      bubbles: true,
      view: window,
      buttons: type === "mouseup" ? 0 : 1,
      clientX: rect.x + rect.width / 2 + dx,
      clientY: rect.y + rect.height / 2 + dy,
    });
  button.dispatchEvent(mouse("mousedown", 0, 0));
  window.dispatchEvent(mouse("mousemove", -10, 10));
  window.dispatchEvent(mouse("mousemove", -60, 50));
  window.dispatchEvent(mouse("mouseup", -60, 50));
  expect(kanban.element().getBoundingClientRect().toJSON()).toEqual(beforeButtonDrag);
  // Card buttons and selected card text keep Delete, even with the kanban selected.
  await userEvent.click(kanban.getByRole("button", { name: "Map the parser" }));
  const beforeCardKey = kanban.element().getBoundingClientRect().toJSON();
  await userEvent.keyboard("{ArrowDown}");
  expect(kanban.element().getBoundingClientRect().toJSON()).toEqual(beforeCardKey);
  await userEvent.keyboard("{Delete}");
  await expect.element(kanban).toBeVisible();

  // Taken off the board and added back, for every viewer.
  const workflowPath = "/api/board/workflows/board-seam";
  await userEvent.click(kanban.getByRole("button", { name: "Remove kanban from board" }));
  await expect.element(kanban).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Undo (Ctrl+Z)" }));
  await expect.element(kanban).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Redo (Ctrl+Y)" }));
  await expect.element(kanban).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add kanban" }));
  await expect
    .element(screen.getByRole("region", { name: "Kanban" }).getByText("Map the parser"))
    .toBeVisible();
  await vi.waitFor(() => expect(inView()).toBe(true));
  expect(boardPosts().filter((path) => path === workflowPath)).toHaveLength(4);
  await expect.element(screen.getByRole("button", { name: "Show kanban" })).toBeVisible();
  await userEvent.click(kanban.getByText("Kanban", { exact: true }));
  await userEvent.keyboard("{Delete}");
  await expect.element(kanban).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Undo (Ctrl+Z)" }));
  await expect.element(kanban).toBeVisible();
  emit({ kind: "workflow.upserted", sequence: 100, workflow: { ...workflow, runs: [] } });
  emit({
    kind: "kanban.upserted",
    sequence: 101,
    workflowId: workflow.id,
    card: {
      id: "legacy",
      title: "Completed before runs were recorded",
      body: "",
      status: "done",
      updatedBy: "engine",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  await expect.element(kanban.getByText("Completed before runs were recorded")).toBeVisible();
});
