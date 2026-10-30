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

it("restores a workflow opened empty after adding its kanban", async () => {
  await using board = await openBoard({ empty: true });
  const { screen } = board;
  await userEvent.click(screen.getByRole("button", { name: "Add kanban" }));
  const kanban = screen.getByRole("region", { name: "Kanban" });
  await expect.element(kanban).toBeVisible();
  const restore = screen.getByRole("button", { name: "Restore the board as it was when opened" });
  await expect.element(restore).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Seam workflow", exact: true }).first());
  await expect.element(restore).toBeEnabled();
  await userEvent.click(restore);
  await expect.element(kanban).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Undo (Ctrl+Z)" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Redo (Ctrl+Y)" })).toBeDisabled();
});
