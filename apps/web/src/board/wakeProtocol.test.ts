import { describe, expect, it } from "vite-plus/test";

import {
  buildBoardInstructions,
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
    expect(parseWakeBlocks('<wake node="A">  </wake><wake node="">x</wake><wake node="B">y')).toEqual(
      [],
    );
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
