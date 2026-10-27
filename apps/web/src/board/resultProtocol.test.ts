import { describe, expect, it } from "vite-plus/test";

import {
  buildAgentFirstPrompt,
  buildBoardInstructions,
  buildRequestMessage,
  connectedNodeNames,
  incomingNodeNames,
  matchNodeName,
  parseResult,
} from "./resultProtocol";

const fence = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";

describe("parseResult", () => {
  it("parses a finish result", () => {
    const parsed = parseResult(
      `done\n${fence({ summary: "ok", data: { a: 1 }, routing: { kind: "finish" } })}`,
    );
    expect(parsed).toEqual({
      ok: true,
      result: { summary: "ok", data: { a: 1 }, routing: { kind: "finish" } },
    });
  });

  it("parses requests with optional input", () => {
    const parsed = parseResult(
      fence({
        summary: "s",
        routing: {
          kind: "request",
          requests: [
            { to: " QA ", task: "test", input: [1] },
            { to: "Dev", task: "fix" },
          ],
        },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      result: {
        summary: "s",
        data: null,
        routing: {
          kind: "request",
          requests: [
            { to: "QA", task: "test", input: [1] },
            { to: "Dev", task: "fix" },
          ],
        },
      },
    });
  });

  it("parses a return with and without requestId", () => {
    const withId = parseResult(
      fence({ summary: "s", routing: { kind: "return", requestId: "r1" } }),
    );
    expect(withId.ok && withId.result.routing).toEqual({ kind: "return", requestId: "r1" });
    const without = parseResult(fence({ summary: "s", routing: { kind: "return" } }));
    expect(without.ok && without.result.routing).toEqual({ kind: "return" });
  });

  it("uses the LAST json block", () => {
    const text = `${fence({ summary: "first", routing: { kind: "finish" } })}\n${fence({ summary: "second", routing: { kind: "finish" } })}`;
    const parsed = parseResult(text);
    expect(parsed.ok && parsed.result.summary).toBe("second");
  });

  it("rejects a missing block", () => {
    expect(parseResult("just prose")).toMatchObject({ ok: false });
  });

  it("rejects bad JSON", () => {
    expect(parseResult("```json\n{nope\n```")).toMatchObject({ ok: false });
  });

  it("rejects a missing or too long summary", () => {
    expect(parseResult(fence({ routing: { kind: "finish" } }))).toMatchObject({ ok: false });
    expect(
      parseResult(fence({ summary: "x".repeat(601), routing: { kind: "finish" } })),
    ).toMatchObject({ ok: false });
  });

  it("rejects an unknown kind and empty requests", () => {
    expect(parseResult(fence({ summary: "s", routing: { kind: "wake" } }))).toMatchObject({
      ok: false,
    });
    expect(
      parseResult(fence({ summary: "s", routing: { kind: "request", requests: [] } })),
    ).toMatchObject({ ok: false });
    expect(
      parseResult(fence({ summary: "s", routing: { kind: "request", requests: [{ to: "A" }] } })),
    ).toMatchObject({ ok: false });
  });
});

describe("helpers", () => {
  it("matches names case-insensitively", () => {
    expect(matchNodeName(["Italy", "Local"], " italy ")).toBe("Italy");
    expect(matchNodeName(["Italy"], "x")).toBeNull();
  });

  it("lists outgoing and incoming names by edge direction", () => {
    const nodes = [
      { id: "1", name: "A" },
      { id: "2", name: "B" },
      { id: "3", name: "C" },
    ];
    const edges = [
      { a: "1", b: "2" },
      { a: "3", b: "1" },
    ];
    expect(connectedNodeNames(nodes, edges, "1")).toEqual(["B"]);
    expect(incomingNodeNames(nodes, edges, "1")).toEqual(["C"]);
  });

  it("explains the contract with both name lists", () => {
    const text = buildBoardInstructions("Dev", ["QA"], ["Lead"]);
    expect(text).toContain('"kind": "request"');
    expect(text).toContain('"kind": "return"');
    expect(text).toContain('"kind": "finish"');
    expect(text).toContain("THIS MESSAGE IS A BRIEFING");
    expect(text).toContain("You can send requests to:\n- QA");
    expect(text).toContain("may send requests to you:\n- Lead");
  });

  it("prefixes the role in the first prompt", () => {
    expect(buildAgentFirstPrompt("Dev", " Fix bugs ", [])).toMatch(
      /^Fix bugs\n\n\(The role above[\s\S]*\[Board\]/,
    );
    expect(buildAgentFirstPrompt("Dev", " ", ["QA"])).toBe(buildBoardInstructions("Dev", ["QA"]));
  });

  it("builds a request message with header and json", () => {
    const text = buildRequestMessage({ requestId: "r1", from: "A", task: "t" });
    expect(text.startsWith("[Board] Work request")).toBe(true);
    expect(text).toContain('"requestId": "r1"');
  });
});
