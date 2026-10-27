import { describe, expect, it } from "vite-plus/test";

import {
  buildAgentFirstPrompt,
  buildBoardInstructions,
  connectedNodeNames,
  buildResultMessage,
  buildTaskMessage,
  matchNodeName,
  parseWakeBlocks,
} from "./wakeProtocol";

describe("parseWakeBlocks", () => {
  it("parses a single block and trims the task", () => {
    expect(parseWakeBlocks('Hi\n<wake node="Italy">\n  run the tests \n</wake>\nbye')).toEqual([
      { node: "Italy", task: "run the tests" },
    ]);
  });

  it("parses several blocks in order", () => {
    const text = '<wake node="A">one</wake> text <wake node="B">two\nlines</wake>';
    expect(parseWakeBlocks(text)).toEqual([
      { node: "A", task: "one" },
      { node: "B", task: "two\nlines" },
    ]);
  });

  it("ignores empty tasks, empty names and unclosed blocks", () => {
    expect(
      parseWakeBlocks('<wake node="A">  </wake><wake node="">x</wake><wake node="B">y'),
    ).toEqual([]);
  });

  it("returns nothing for plain text", () => {
    expect(parseWakeBlocks("no blocks here")).toEqual([]);
  });
});

describe("matchNodeName", () => {
  it("matches case-insensitively", () => {
    expect(matchNodeName(["Italy", "Local"], " italy ")).toBe("Italy");
    expect(matchNodeName(["Italy"], "mars")).toBeNull();
  });
});

describe("messages", () => {
  it("lists connected nodes in the instructions", () => {
    const text = buildBoardInstructions("Local", ["Italy"]);
    expect(text).toContain('<wake node="NodeName">');
    expect(text).toContain("- Italy");
  });

  it("formats task and result messages", () => {
    expect(buildTaskMessage("Local", "do x")).toBe(
      "[Board] Task from Local:\n\ndo x\n\nYour final reply will be sent back to Local.",
    );
    expect(buildResultMessage("Italy", "done")).toBe("[Board] Result from Italy:\n\ndone");
  });
});

describe("connectedNodeNames", () => {
  const nodes = [
    { id: "1", name: "A" },
    { id: "2", name: "B" },
    { id: "3", name: "C" },
  ];
  const edges = [
    { a: "1", b: "2" },
    { a: "3", b: "1" },
  ];

  it("lists neighbours in either edge direction", () => {
    expect(connectedNodeNames(nodes, edges, "1")).toEqual(["B", "C"]);
    expect(connectedNodeNames(nodes, edges, "2")).toEqual(["A"]);
  });
});

describe("buildAgentFirstPrompt", () => {
  it("puts the role before the board instructions", () => {
    const text = buildAgentFirstPrompt("Dev", " Fix bugs ", []);
    expect(text.startsWith("Fix bugs\n\n[Board]")).toBe(true);
    expect(text).toContain("(none yet)");
  });

  it("uses the instructions alone without a role", () => {
    expect(buildAgentFirstPrompt("Dev", "  ", ["QA"])).toBe(buildBoardInstructions("Dev", ["QA"]));
  });
});
