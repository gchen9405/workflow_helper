/**
 * The terminal conversation — readline over the TTY, with a console-device
 * fallback so piped stdin does not silently cost the conversation.
 *
 * The person types in their own words. `/done` (or `/quit`, `/exit`, or
 * end of input) ends the conversation from this side without a model call;
 * saying "that's all" in plain words works too, via interpretation.
 */
import { createReadStream, openSync } from "node:fs";
import process from "node:process";
import * as readline from "node:readline/promises";
import type { ConversationIO } from "../run.js";

/** Typed alone on a line, these end the conversation immediately. */
export const END_COMMANDS = ["/done", "/quit", "/exit", "/stop"];

const BANNER =
  "— Reply in your own words. Type /done at any time to finish with what has been gathered. —";

export class TerminalConversationIO implements ConversationIO {
  private announced = false;

  constructor(
    private readonly rl: readline.Interface,
    private readonly out: (line: string) => void = (line) => console.log(line),
  ) {}

  async reply(message: string): Promise<string | null> {
    if (!this.announced) {
      this.announced = true;
      this.out(`\n${BANNER}`);
    }
    this.out(`\nAssistant: ${message.split("\n").join("\n           ")}`);
    for (;;) {
      let raw: string;
      try {
        raw = await this.rl.question("\nYou: ");
      } catch {
        // The interface closed (end of input): the person is done.
        return null;
      }
      const text = raw.trim();
      if (text === "") continue;
      if (END_COMMANDS.includes(text.toLowerCase())) return null;
      return text;
    }
  }
}

/**
 * The console's input device, for reading prompts when stdin is a pipe.
 * POSIX exposes the controlling terminal as /dev/tty; Windows exposes the
 * console input buffer as CONIN$.
 */
const CONSOLE_INPUT = process.platform === "win32" ? "\\\\.\\CONIN$" : "/dev/tty";

/**
 * Open the conversation channel. When stdin is a pipe it has been consumed by
 * the input itself, so the person's replies are read from the console device
 * instead — piping an input should not silently disable the conversation.
 * Returns null when no console is available (CI, a cron job), and the caller
 * falls back to the non-interactive path.
 *
 * The console device is only attempted when stdout is still a terminal. That
 * is the evidence that a console exists to read from; without it, opening the
 * device could succeed and then never deliver a keystroke, which would look
 * like a hang instead of a clean fallback.
 */
export function openTerminalConversation(): {
  io: TerminalConversationIO;
  close: () => void;
} | null {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return { io: new TerminalConversationIO(rl), close: () => rl.close() };
  }
  if (!process.stdout.isTTY) return null;
  try {
    const fd = openSync(CONSOLE_INPUT, "r");
    const input = createReadStream("", { fd, autoClose: true });
    const rl = readline.createInterface({ input, output: process.stdout });
    return {
      io: new TerminalConversationIO(rl),
      close: () => {
        rl.close();
        input.destroy();
      },
    };
  } catch {
    return null;
  }
}
