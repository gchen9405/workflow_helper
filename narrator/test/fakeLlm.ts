/**
 * The FakeLlm convention shared with the sibling packages: canned fixtures
 * are parsed through the stage's REAL Zod schema and run through its REAL
 * semanticCheck, proving they are shaped like legal model output.
 */
import {
  LlmRepairExhaustedError,
  type LlmClient,
  type StructuredCallOptions,
} from "workflow-preprocessor";
import type { NodeProfile } from "workflow-recommender";

export type Handler = (options: StructuredCallOptions<unknown>) => unknown;

export class FakeLlm implements LlmClient {
  calls = 0;
  /** The user prompts each call was given, for prompt assertions. */
  prompts: string[] = [];

  constructor(private readonly handlers: Record<string, Handler>) {}

  async structured<T>(options: StructuredCallOptions<T>): Promise<T> {
    const handler = this.handlers[options.taskLabel];
    if (!handler) throw new Error(`no fake handler for task "${options.taskLabel}"`);
    this.calls++;
    this.prompts.push(
      options.user.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    );
    const value = options.schema.parse(handler(options as StructuredCallOptions<unknown>));
    const errors = options.semanticCheck?.(value) ?? [];
    if (errors.length > 0) {
      // Mirror the real client: semantic failure with no successful repair.
      throw new LlmRepairExhaustedError(options.taskLabel, 1, errors);
    }
    return value;
  }
}

/** A client whose every call fails with the given error — endpoint trouble. */
export class FailingLlm implements LlmClient {
  calls = 0;
  constructor(private readonly error: Error) {}
  async structured<T>(_options: StructuredCallOptions<T>): Promise<T> {
    this.calls++;
    throw this.error;
  }
}

/** Node ids a profiling call asked for, read back out of the user prompt. */
export function requestedIds(options: StructuredCallOptions<unknown>): string[] {
  const text = options.user
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
  return [...text.matchAll(/^- id: (.+)$/gm)].map((m) => m[1]);
}

/** A recommender profiling handler that answers each requested id from a canned map. */
export function profileHandler(byId: Record<string, NodeProfile>): Handler {
  return (options) => ({
    profiles: requestedIds(options).map((id) => {
      const profile = byId[id];
      if (!profile) throw new Error(`fixture has no profile for requested id "${id}"`);
      return profile;
    }),
  });
}
