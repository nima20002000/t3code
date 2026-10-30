import type {
  PreviewStreamControl,
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { EnvironmentId, type PreviewSetupHostResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { ServerBrowserSurface } from "./ServerBrowserSurface";

const mocks = vi.hoisted(() => ({
  access: { wsBase: "ws://server.test" },
  sent: [] as Array<PreviewStreamInput>,
  events: null as PreviewStreamEvents | null,
  setupHost: null as null | ((request: unknown) => Promise<unknown>),
}));

const setup = () => {
  mocks.sent.length = 0;
  mocks.events = null;
  mocks.setupHost = null;
};

// The stream's socket and canvas painter; the test plays the server's side.
vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => ({
  ...(await original()),
  createPreviewStreamClient: (_target, events) => {
    mocks.events = events;
    return {
      send: (input) => {
        mocks.sent.push(input);
        return true;
      },
      stop: () => {},
    };
  },
  createPreviewFramePainter: () => ({ paint: () => {}, stop: () => {} }) as never,
}));

vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => mocks.access as never,
  refreshPreviewStreamAccess: () => {},
}));

vi.mock(import("~/state/preview"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    previewEnvironment: {
      ...actual.previewEnvironment,
      setupHost: {
        ...actual.previewEnvironment.setupHost,
        permissionAtom: () => Atom.make(true),
      },
    },
  };
});

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: () => ((request: unknown) => mocks.setupHost!(request)) as never,
}));

const ENVIRONMENT = EnvironmentId.make("environment-1");

const control = (controller: PreviewStreamControl["controller"]): PreviewStreamControl => ({
  canOperate: true,
  controller,
  generation: 1,
  dialog: null,
});

const renderBrowser = async () => {
  const screen = await render(
    <div>
      <div data-server-browser-scope style={{ width: 640, height: 480 }}>
        <button type="button">Address bar</button>
        <ServerBrowserSurface
          environmentId={ENVIRONMENT}
          threadId="thread-1"
          tabId="tab-1"
          visible
          className="h-96 w-full"
        />
      </div>
      <button type="button">Elsewhere</button>
    </div>,
    // The surface uses no links or navigation.
    { router: false },
  );
  await vi.waitFor(() => expect(mocks.events).not.toBeNull());
  return screen;
};

const serverSays = (next: PreviewStreamControl) => act(() => mocks.events!.onControl?.(next));
const canvas = () => document.querySelector("canvas")!;

describe("ServerBrowserSurface control", () => {
  it("takes control when the page is clicked and hands it back on a click elsewhere", async () => {
    setup();
    await using screen = await renderBrowser();
    await serverSays(control("agent"));

    await userEvent.click(canvas());
    expect(mocks.sent).toContainEqual({ type: "takeControl" });
    await serverSays(control("you"));
    await expect.element(screen.getByRole("button", { name: "Release control" })).toBeVisible();
    // The keyboard follows the click into the page.
    expect(document.activeElement).toBe(screen.getByLabelText("Browser page").element());

    // The browser's own chrome keeps control.
    await userEvent.click(screen.getByRole("button", { name: "Address bar" }));
    expect(mocks.sent).not.toContainEqual({ type: "releaseControl" });

    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(mocks.sent).toContainEqual({ type: "releaseControl" });
  });

  it("takes control on a wheel over the page, but not around it or from another viewer", async () => {
    setup();
    await using screen = await renderBrowser();
    await serverSays(control("another-viewer"));
    await act(() => canvas().dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true })));
    expect(mocks.sent).not.toContainEqual({ type: "takeControl" });

    await serverSays(control("agent"));
    await userEvent.hover(canvas());
    await act(() =>
      screen
        .getByRole("button", { name: "Elsewhere" })
        .element()
        .dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true })),
    );
    expect(mocks.sent).not.toContainEqual({ type: "takeControl" });

    await act(() => canvas().dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true })));
    expect(mocks.sent).toContainEqual({ type: "takeControl" });
  });
});

describe("ServerBrowserSurface control handoff", () => {
  it("gives back a grant that arrives after the user already clicked elsewhere", async () => {
    setup();
    await using screen = await renderBrowser();
    await serverSays(control("agent"));
    await userEvent.click(canvas());
    expect(mocks.sent).toContainEqual({ type: "takeControl" });
    // The user moves on before the server answers.
    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    await serverSays(control("you"));
    expect(mocks.sent).toContainEqual({ type: "releaseControl" });
    expect(document.activeElement).not.toBe(screen.getByLabelText("Browser page").element());
  });

  it("hands control back when the user clicks into an app dialog", async () => {
    setup();
    await using _screen = await renderBrowser();
    await serverSays(control("agent"));
    await userEvent.click(canvas());
    await serverSays(control("you"));
    const dialog = document.createElement("div");
    dialog.dataset.slot = "command-dialog-popup";
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Command");
    dialog.append(input);
    document.body.append(dialog);
    try {
      await userEvent.click(input);
      expect(mocks.sent).toContainEqual({ type: "releaseControl" });
    } finally {
      dialog.remove();
    }
  });
});

describe("ServerBrowserSurface host setup", () => {
  const needsSetup = () =>
    act(() =>
      mocks.events!.onHostSetup?.({
        need: "browser",
        command: "sudo t3 browser setup --mode headed",
      }),
    );

  it("sets the machine up on the server and retries the browser", async () => {
    setup();
    let finish: (result: unknown) => void = () => {};
    mocks.setupHost = () => new Promise((resolve) => (finish = resolve));
    await using _screen = await renderBrowser();
    await needsSetup();
    const first = mocks.events;
    await userEvent.click(page.getByRole("button", { name: "Set up" }));
    await expect.element(page.getByRole("button", { name: "Setting up…" })).toBeDisabled();
    finish({
      _tag: "Success",
      value: { _tag: "Ready", ranSetup: true } satisfies PreviewSetupHostResult,
    });
    // The browser reconnects with a fresh stream.
    await vi.waitFor(() => expect(mocks.events).not.toBe(first));
    await expect.element(page.getByRole("button", { name: "Set up" })).not.toBeInTheDocument();
  });

  it("shows the command to run by hand when sudo asks for a password", async () => {
    setup();
    mocks.setupHost = async () => ({
      _tag: "Success",
      value: {
        _tag: "NeedsPassword",
        command: "sudo t3 browser setup --mode headed",
      } satisfies PreviewSetupHostResult,
    });
    await using _screen = await renderBrowser();
    await needsSetup();
    await userEvent.click(page.getByRole("button", { name: "Set up" }));
    await expect.element(page.getByText(/sudo on this machine asks for a password/)).toBeVisible();
    await expect.element(page.getByText("$sudo t3 browser setup --mode headed")).toBeVisible();
  });
});
