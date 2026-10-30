import type { BoardNode } from "./boardStore";
import { EnvironmentId, ProviderInstanceId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
import { cloneElement } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { NodeScheduleButton } from "./NodeSchedule";

const save = vi.hoisted(() => ({ reject: (_error: Error) => {} }));

vi.mock("./boardStore", () => ({
  saveNodeSchedule: () =>
    new Promise((_resolve, reject) => {
      save.reject = reject;
    }),
  setNodeScheduleEnabled: () => Promise.resolve(),
  deleteNodeSchedule: () => Promise.resolve(),
  syncNodeSchedule: () => {},
}));
vi.mock("./useNodeConnection", () => ({ useNodeConnections: () => () => "connected" }));
// The popover renders inline; the board's schedule lives on a machine the test has no list for.
vi.mock("./upstream", () => ({
  Button: (props: { children?: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  Popover: (props: { children: ReactNode }) => <div>{props.children}</div>,
  PopoverTrigger: (props: { render: ReactElement; children: ReactNode }) =>
    cloneElement(props.render, {}, props.children),
  PopoverPopup: (props: { children: ReactNode }) => <div>{props.children}</div>,
  serverEnvironment: { scheduledTasksLive: () => null },
  useEnvironmentQuery: () => ({ data: null, dataUpdatedAt: 0 }),
}));

const environmentId = EnvironmentId.make("vps");
const node = (schedule?: BoardNode["schedule"]): BoardNode => ({
  id: "agent",
  name: "Agent",
  profile: "worker",
  environmentId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  threadId: ThreadId.make("chat"),
  x: 0,
  y: 0,
  ...(schedule ? { schedule } : {}),
});

it("keeps what was typed and shows the error when the machine refuses the schedule", async () => {
  // The popover needs no routes.
  await using screen = await render(<NodeScheduleButton node={node()} />, { router: false });
  await userEvent.fill(screen.getByPlaceholder("What should the agent do each time?"), "Check in");
  await userEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  // The hub marks the node before writing to the machine, then clears the mark on refusal.
  await screen.rerender(
    <NodeScheduleButton node={node({ environmentId, taskId: ScheduledTaskId.make("task") })} />,
  );
  await screen.rerender(<NodeScheduleButton node={node()} />);
  save.reject(new Error("The agent's machine runs a t3 without run limits."));
  await expect.element(screen.getByText(/without run limits/)).toBeVisible();
  await expect
    .element(screen.getByPlaceholder("What should the agent do each time?"))
    .toHaveValue("Check in");
});
