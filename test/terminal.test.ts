/**
 * The terminal conversation IO, over a stubbed readline: the banner shows
 * once, empty lines are asked again, the end commands and a closed interface
 * end the conversation without a model call.
 */
import { describe, expect, it } from "vitest";
import type * as readline from "node:readline/promises";
import { TerminalConversationIO } from "../src/io/terminal.js";

function fakeReadline(...lines: string[]): readline.Interface {
  let i = 0;
  return {
    async question(): Promise<string> {
      if (i >= lines.length) throw new Error("closed");
      return lines[i++];
    },
  } as unknown as readline.Interface;
}

describe("TerminalConversationIO", () => {
  it("shows the banner once, prints the message, and returns the trimmed reply", async () => {
    const out: string[] = [];
    const io = new TerminalConversationIO(fakeReadline("  first answer ", "second"), (l) => out.push(l));
    expect(await io.reply("Hello?\nSecond line")).toBe("first answer");
    expect(await io.reply("Next?")).toBe("second");
    expect(out.filter((l) => l.includes("/done"))).toHaveLength(1);
    expect(out.join("\n")).toContain("Assistant: Hello?\n           Second line");
  });

  it("asks again on an empty line", async () => {
    const io = new TerminalConversationIO(fakeReadline("", "   ", "yes"), () => {});
    expect(await io.reply("?")).toBe("yes");
  });

  it("ends on /done (any case) and when the interface closes", async () => {
    const io = new TerminalConversationIO(fakeReadline("/DONE"), () => {});
    expect(await io.reply("?")).toBeNull();
    expect(await io.reply("?")).toBeNull(); // no more lines: closed
  });
});
