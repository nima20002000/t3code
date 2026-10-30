import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ScheduleButton } from "./ScheduleButton";

vi.mock("../boardApi", () => ({ runBoardMutation: () => Promise.resolve() }));
vi.mock("../boardStore", () => ({
  useCurrentWorkflow: () => ({ id: "workflow" }),
  useBoardSchedules: () => [],
}));
vi.mock("../upstream", async () => {
  const [popover, button] = await Promise.all([
    import("../../components/ui/popover"),
    import("../../components/ui/button"),
  ]);
  return {
    Popover: popover.Popover,
    PopoverPopup: popover.PopoverPopup,
    PopoverTrigger: popover.PopoverTrigger,
    Button: button.Button,
    randomUUID: () => "id",
    useEnvironmentIdentities: () => [],
  };
});

const orchestrator = {
  id: "lead",
  name: "Lead",
  profile: "orchestrator",
  environmentId: "hub",
  modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
  threadId: "",
  x: 0,
  y: 0,
} as never;

it("opens the schedule popover leftwards from the right-hand toolbar, inside the board", async () => {
  // A right panel or a native browser view can cover the window beyond the board's toolbar.
  await page.viewport(1400, 900);
  const container = document.createElement("div");
  container.style.cssText = "position: fixed; top: 8px; right: 400px";
  document.body.append(container);
  // The toolbar sits at the window's right edge; the popover must not run off it.
  await using _screen = await render(<ScheduleButton nodes={[orchestrator]} />, {
    container,
    router: false,
  });
  await userEvent.click(page.getByRole("button", { name: "Schedule" }));
  const field = page.getByPlaceholder("What should each scheduled run do?");
  await expect.element(field).toBeVisible();
  for (const mode of ["interval", "time", "once"]) {
    await userEvent.selectOptions(page.getByRole("combobox", { name: "When" }), mode);
    const popup = document.querySelector<HTMLElement>("[data-slot=popover-popup]")!;
    const bounds = popup.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(container.getBoundingClientRect().right);
    for (const input of popup.querySelectorAll("input, textarea, select"))
      expect(input.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
  }
});
