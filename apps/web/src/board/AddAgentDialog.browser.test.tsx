import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AgentDialog } from "./AddAgentDialog";

const hub = vi.hoisted(() => ({
  pair: (): Promise<unknown> => Promise.reject(new Error("unset")),
}));

vi.mock("./boardApi", () => ({
  pairConnectedMachine: () => Promise.resolve(),
  runBoardMutation: () => hub.pair(),
}));
vi.mock("./BoardWindows", () => ({ loadWindows: () => [] }));
// The hub has paired nothing yet; a new peer only reaches this list after pairing returns.
vi.mock("./useBoardMachines", () => ({
  useBoardMachines: () => [{ environmentId: "hub-env", label: "Hub desktop", paired: true }],
}));
vi.mock("./boardStore", () => ({
  configureNode: () => Promise.resolve(),
  createNode: () => Promise.resolve(),
  nextNodePosition: () => ({ x: 0, y: 0 }),
  useBoardWorkspaces: () => [],
  useCurrentWorkflow: () => ({
    id: "workflow",
    workspaceId: "workspace",
    nodes: [],
    settings: { defaultInstanceId: "codex", defaultModel: "gpt-6-luna" },
  }),
}));
// The dialog renders inline, with no providers known, so the model is typed by hand.
vi.mock("./upstream", () => {
  const Slot = (props: { children?: ReactNode }) => <div>{props.children}</div>;
  return {
    Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
    Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
    Dialog: Slot,
    DialogDescription: Slot,
    DialogFooter: Slot,
    DialogHeader: Slot,
    DialogPanel: Slot,
    DialogPopup: Slot,
    DialogTitle: Slot,
    EMPTY_SERVER_PROVIDERS: [],
    ProviderModelPicker: () => null,
    deriveProviderInstanceEntries: () => [],
    randomUUID: () => "node",
    resolveDefaultProviderModelSelection: () => null,
    useEnvironmentProviders: () => new Map(),
  };
});

const LINK = "https://laptop.example.com/pair#token=one-time";

it("selects a computer added from Add agent", async () => {
  hub.pair = () =>
    Promise.resolve({
      id: "peer",
      name: "Laptop",
      environmentId: "laptop-env",
      url: "https://laptop.example.com",
      status: "connecting",
    });
  // The dialog needs no routes.
  await using screen = await render(<AgentDialog onClose={() => {}} />, { router: false });
  await userEvent.click(screen.getByRole("button", { name: "Add a computer" }));
  await userEvent.fill(screen.getByLabelText("Link from the new computer"), LINK);
  await userEvent.click(screen.getByRole("button", { name: "Add computer", exact: true }));
  await expect.element(screen.getByLabelText("Machine", { exact: true })).toHaveValue("laptop-env");
  await expect.element(screen.getByLabelText("Link from the new computer")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Add agent" })).toBeEnabled();
});

it("shows why a link failed and keeps what was entered", async () => {
  hub.pair = () => Promise.reject(new Error("This pairing link has expired."));
  // The dialog needs no routes.
  await using screen = await render(<AgentDialog onClose={() => {}} />, { router: false });
  await userEvent.fill(screen.getByLabelText("Node name"), "Builder");
  await userEvent.click(screen.getByRole("button", { name: "Add a computer" }));
  await userEvent.fill(screen.getByLabelText("Link from the new computer"), LINK);
  await userEvent.click(screen.getByRole("button", { name: "Add computer", exact: true }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("This pairing link has expired.");
  await expect.element(screen.getByLabelText("Link from the new computer")).toHaveValue(LINK);
  await expect.element(screen.getByLabelText("Node name")).toHaveValue("Builder");
  await expect.element(screen.getByLabelText("Machine", { exact: true })).toHaveValue("hub-env");
});
