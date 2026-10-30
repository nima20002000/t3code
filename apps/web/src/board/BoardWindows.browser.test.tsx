import { expect, it, vi } from "vite-plus/test";

import { syncNativeViews } from "./BoardWindows";

const fixed = (style: string, attributes: Record<string, string> = {}) => {
  const element = document.createElement("div");
  element.style.cssText = `position: fixed; ${style}`;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
};

/** A board with one browser window, its page drawn as a native view in the desktop's host. */
function board() {
  const canvas = fixed("left: 100px; top: 50px; width: 400px; height: 300px");
  const node = fixed("left: 40px; top: 280px; width: 220px; height: 140px");
  node.className = "react-flow__node";
  const browser = document.createElement("div");
  browser.className = "board-window";
  browser.style.cssText = "position: absolute; inset: 0";
  const slot = document.createElement("div");
  slot.style.cssText = "position: absolute; inset: 20px 0 0 0";
  slot.dataset.browserSurfaceSlot = "tab";
  browser.append(slot);
  node.append(browser);
  canvas.append(node);
  // Like the board's full-screen layer, it lets the pointer through to the board.
  const layer = fixed("inset: 0; pointer-events: none");
  const host = document.createElement("div");
  host.dataset.electronBrowserHost = "";
  const view = fixed("left: 40px; top: 300px; width: 220px; height: 120px; z-index: 30", {
    "data-preview-viewport": "tab",
  });
  host.append(view);
  document.body.append(canvas, layer);
  return {
    canvas,
    node,
    layer,
    host,
    view,
    [Symbol.dispose]() {
      canvas.remove();
      layer.remove();
      host.remove();
    },
  };
}

it("clips the desktop's native browser views to their board window and hides them under a full-screen window", async () => {
  using b = board();
  const hidden = fixed("left: -100000px; top: -100000px; width: 10px; height: 10px; z-index: -1", {
    "data-preview-viewport": "tab",
  });
  b.host.append(hidden);
  document.body.append(b.host);

  const stop = syncNativeViews(b.canvas, b.layer);
  // The window hangs off the board's left and bottom edges.
  expect(b.view.style.clipPath).toBe("inset(0px 0px 70px 60px)");
  expect(hidden.style.clipPath).toBe("");

  const chat = fixed("inset: 0");
  chat.className = "board-window";
  b.layer.append(chat);
  await vi.waitFor(() => expect(b.view.style.clipPath).toBe("inset(50%)"));

  chat.remove();
  await vi.waitFor(() => expect(b.view.style.clipPath).toBe("inset(0px 0px 70px 60px)"));
  stop();
  expect(b.view.style.clipPath).toBe("");
});

it("moves a board page with its window as soon as the window moves", async () => {
  using b = board();
  document.body.append(b.host);
  using _sync = { [Symbol.dispose]: syncNativeViews(b.canvas, b.layer) };

  b.node.style.left = "160px";
  b.node.style.top = "100px";
  await vi.waitFor(() => {
    expect(b.view.style.left).toBe("160px");
    expect(b.view.style.top).toBe("120px");
  });
});

it("hides a board page under a full-screen window when the desktop's views appear after the board", async () => {
  using b = board();
  using _sync = { [Symbol.dispose]: syncNativeViews(b.canvas, b.layer) };
  const chat = fixed("inset: 0");
  chat.className = "board-window";
  b.layer.append(chat);

  document.body.append(b.host);
  b.view.style.width = "221px";
  await vi.waitFor(() => expect(b.view.style.clipPath).toBe("inset(50%)"));
});

it("keeps a board page under the windows and panels drawn above its window", async () => {
  using b = board();
  b.node.style.zIndex = "10";
  // The page shows at x 100-260, y 300-350. A window stacked above the browser covers its right end.
  const front = fixed("left: 180px; top: 290px; width: 200px; height: 100px; z-index: 11");
  front.className = "react-flow__node";
  // An agent stacked below it, under the page's left end.
  const back = fixed("left: 90px; top: 305px; width: 20px; height: 20px; z-index: 0");
  back.className = "react-flow__node";
  b.canvas.append(front, back);
  document.body.append(b.host);
  using _sync = { [Symbol.dispose]: syncNativeViews(b.canvas, b.layer) };

  expect(document.elementFromPoint(200, 320)).toBe(front);
  expect(document.elementFromPoint(150, 320)).toBe(b.view);
  expect(document.elementFromPoint(105, 315)).toBe(b.view);

  // A panel floating over the board, like run details, opens over the page.
  const panel = fixed("left: 120px; top: 320px; width: 30px; height: 20px; z-index: 20");
  b.canvas.append(panel);
  await vi.waitFor(() => expect(document.elementFromPoint(130, 330)).toBe(panel));
  expect(document.elementFromPoint(160, 330)).toBe(b.view);

  // Selecting the browser brings it to the front.
  b.node.style.zIndex = "1010";
  await vi.waitFor(() => expect(document.elementFromPoint(200, 320)).toBe(b.view));
});
