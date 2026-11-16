/**
 * A stubbed LlmClient for orchestration and conversation tests — no network.
 *
 * It honors the real client's contract: every canned value is validated
 * against the call's actual Zod schema and run through the call's
 * semanticCheck, so these tests also prove the fixtures (and the wiring) are
 * shaped exactly like real model output would have to be. A semantic failure
 * is reported the way the real client reports an exhausted repair loop.
 *
 * Handlers are keyed by task label and receive the call options plus how
 * many times that label has been called before, so a test can script a
 * sequence ("first message: patches; second message: finish").
 */
import {
  LlmRepairExhaustedError,
  type LlmClient,
  type StructuredCallOptions,
} from "../src/llm/client.js";

export type Handler = (options: StructuredCallOptions<unknown>, call: number) => unknown;

export class FakeLlm implements LlmClient {
  /** Every call made, in order: its label and the text it was given. */
  readonly calls: { taskLabel: string; text: string }[] = [];

  constructor(private readonly handlers: Record<string, Handler>) {}

  /** How many calls carried this label. */
  count(taskLabel: string): number {
    return this.calls.filter((c) => c.taskLabel === taskLabel).length;
  }

  async structured<T>(options: StructuredCallOptions<T>): Promise<T> {
    const handler = this.handlers[options.taskLabel];
    if (!handler) throw new Error(`no fake handler for task "${options.taskLabel}"`);
    const call = this.count(options.taskLabel);
    this.calls.push({
      taskLabel: options.taskLabel,
      text: options.user.map((p) => (p.type === "text" ? p.text : "<image>")).join("\n"),
    });
    const value = options.schema.parse(handler(options as StructuredCallOptions<unknown>, call));
    const errors = options.semanticCheck?.(value) ?? [];
    if (errors.length > 0) {
      // Mirror the real client: semantic failure with no successful repair.
      throw new LlmRepairExhaustedError(options.taskLabel, 1, errors);
    }
    return value;
  }
}

/** A handler that answers each call from a list, repeating the last entry. */
export function sequence(...values: unknown[]): Handler {
  return (_options, call) => values[Math.min(call, values.length - 1)];
}
