/**
 * Provider-neutral LLM contract.
 *
 * The pipeline only ever depends on the `LlmClient` interface — a single
 * `structured()` call that turns (system prompt, user content, Zod schema)
 * into a validated object. Which provider actually serves the call is an
 * implementation detail; the shipped implementation is
 * `InternalLlmClient` (`./internalClient.ts`), which talks to an
 * OpenAI-compatible chat-completions endpoint such as a company-internal
 * LLM gateway.
 *
 * Implementations must uphold two contracts:
 *
 * 1. Structured output: the returned value satisfies the given Zod schema
 *    and the optional `semanticCheck`.
 *
 * 2. The MACHINE-FACING REPAIR LOOP. When the model's output is structurally
 *    invalid — fails the schema, or a semantic check like "edge references a
 *    node that doesn't exist" — the errors are fed back to the model and the
 *    call retried, up to a small bound. This loop is strictly internal: it
 *    never surfaces to the user and is completely separate from the
 *    user-facing clarification loop, which deals with *missing information
 *    in the input*, not with malformed model output.
 *
 * Every call is a stateless function over its inputs: a fresh message list is
 * built per call; nothing is carried over between calls.
 */
import type { ZodType } from "zod";
import type { ImageMediaType } from "../io/payload.js";

/**
 * Provider-neutral content parts. The pipeline stages produce these; each
 * client implementation converts them to its provider's wire format.
 */
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: ImageMediaType; base64: string };

export interface StructuredCallOptions<T> {
  /** System prompt for this stage. */
  system: string;
  /** User content parts (text, and for image inputs an image part). */
  user: LlmContentPart[];
  /** Zod schema the output must satisfy. */
  schema: ZodType<T>;
  /** Short label used in error messages ("triage", "extraction", ...). */
  taskLabel: string;
  /**
   * Optional semantic validation beyond the schema shape (cross-references,
   * id uniqueness, dry-run patch application). Return [] when valid;
   * non-empty error strings trigger a repair retry.
   */
  semanticCheck?: (value: T) => string[];
  /** Repair retries after the first attempt. Default 2 (3 attempts total). */
  maxRepairAttempts?: number;
}

/** Minimal interface the pipeline depends on — tests can stub it. */
export interface LlmClient {
  structured<T>(options: StructuredCallOptions<T>): Promise<T>;
}

/**
 * The endpoint's safety layer declined the request (e.g. a content filter).
 * The pipeline maps this to the graceful-rejection terminal state — it is
 * never retried and never presented as a schema.
 */
export class LlmRefusalError extends Error {
  constructor(taskLabel: string) {
    super(`the model declined to process the input during ${taskLabel}`);
    this.name = "LlmRefusalError";
  }
}

/**
 * The repair loop ran out of attempts without producing structurally valid
 * output. Depending on where in the pipeline this happens, the caller maps it
 * to graceful rejection (no schema exists yet) or a partial result (a schema
 * exists but an answer round failed).
 */
export class LlmRepairExhaustedError extends Error {
  readonly errors: string[];
  constructor(taskLabel: string, attempts: number, errors: string[]) {
    super(
      `${taskLabel} did not produce structurally valid output after ${attempts} attempt(s): ${errors.join("; ")}`,
    );
    this.name = "LlmRepairExhaustedError";
    this.errors = errors;
  }
}
