/**
 * Interactive clarification IO — readline over the terminal, with a
 * console-device fallback so piped stdin does not silently cost the
 * clarification loop.
 *
 * The question type this module accepts is deliberately minimal
 * ({@link AskableQuestion}: just `id` and `text`): any component whose
 * questions carry those two fields can drive this IO. That is what lets
 * sibling components (e.g. the recommender) reuse the exact same terminal
 * behavior without depending on this package's Gap union — their richer
 * question objects are structurally assignable to `AskableQuestion`.
 */
import { createReadStream, openSync } from "node:fs";
import process from "node:process";
import * as readline from "node:readline/promises";
import type { BatchAnswers } from "../pipeline/run.js";
import type { AskableQuestion } from "./silent.js";

// The question shape and the non-interactive IO live in `silent.ts` (no
// Node imports, so the browser bundle can use them); re-exported here so
// Node callers see one module, as before.
export { silentIO, type AskableQuestion } from "./silent.js";

/** Interactive clarification over a readable TTY. */
export class ReadlineClarificationIO {
  constructor(private readonly rl: readline.Interface) {}

  async askBatch(
    questions: readonly AskableQuestion[],
    round: number,
  ): Promise<BatchAnswers> {
    console.log(
      `\n— Clarification round ${round}: ${questions.length} question(s). ` +
        `Answer, press Enter to skip, or type "stop" to finish with what we have. —\n`,
    );
    const answers: BatchAnswers["answers"] = [];
    for (const [i, question] of questions.entries()) {
      const raw = await this.rl.question(`${i + 1}. ${question.text}\n   > `);
      const answer = raw.trim();
      if (answer.toLowerCase() === "stop") {
        return { stopped: true, answers };
      }
      answers.push({ questionId: question.id, answer });
    }
    return { stopped: false, answers };
  }
}

/**
 * The console's input device, for reading prompts when stdin is a pipe.
 * POSIX exposes the controlling terminal as /dev/tty; Windows exposes the
 * console input buffer as CONIN$.
 */
const CONSOLE_INPUT = process.platform === "win32" ? "\\\\.\\CONIN$" : "/dev/tty";

/**
 * Open a question channel. When stdin is a pipe it has been consumed by the
 * input itself, so prompts are read from the console device instead — piping
 * an input should not silently disable clarification. Returns null when no
 * console is available (CI, a cron job), and the caller falls back to the
 * non-interactive path.
 *
 * The console device is only attempted when stdout is still a terminal. That
 * is the evidence that a console exists to read from; without it, opening the
 * device could succeed and then never deliver a keystroke, which would look
 * like a hang instead of a clean fallback.
 */
export function openClarificationIO(): {
  io: ReadlineClarificationIO;
  close: () => void;
} | null {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return { io: new ReadlineClarificationIO(rl), close: () => rl.close() };
  }
  if (!process.stdout.isTTY) return null;
  try {
    const fd = openSync(CONSOLE_INPUT, "r");
    const input = createReadStream("", { fd, autoClose: true });
    const rl = readline.createInterface({ input, output: process.stdout });
    return {
      io: new ReadlineClarificationIO(rl),
      close: () => {
        rl.close();
        input.destroy();
      },
    };
  } catch {
    return null;
  }
}
