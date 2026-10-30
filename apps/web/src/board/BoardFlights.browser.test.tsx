import type { EdgeRunView } from "@t3tools/board-core/runView";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { useFlights } from "./BoardPage";

const edges = [{ a: "a", b: "c" }];
const view = (crossings: EdgeRunView["crossings"]) =>
  new Map<string, EdgeRunView>([["a:c", { pending: 0, crossings }]]);

function Probe(props: { readonly crossings: EdgeRunView["crossings"] }) {
  const { pulses } = useFlights(view(props.crossings), edges);
  return <output>{pulses.get("a:c")?.length ?? 0}</output>;
}

it("an edge only draws flights still on their way, so a restored edge does not replay old ones", async () => {
  using _timers = fakeTimers();
  await using screen = await render(<Probe crossings={[]} />, { router: false });
  await screen.rerender(
    <Probe crossings={[{ key: "r1:task", signal: "task", at: "2026-01-01T00:00:00Z" }]} />,
  );
  expect(screen.container.querySelector("output")?.textContent).toBe("1");
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.container.querySelector("output")?.textContent).toBe("0");
});
