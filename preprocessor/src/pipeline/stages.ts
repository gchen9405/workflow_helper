/**
 * The three input-side LLM stages. Each is a stateless function over the
 * pipeline state: it takes the relevant slice, makes one structured LLM call
 * (with the internal repair loop), and returns plain data.
 *
 *   1. triage     — is this a workflow at all? (runs on the raw input)
 *   2. normalize  — raw input -> graph-shaped text intermediate
 *                   (the ONLY stage that ever sees an image)
 *   3. extract    — intermediate -> ExtractionDraft
 *                   (runs ONLY on the intermediate, never on the raw input)
 */
import { z } from "zod";
import type { LlmClient, LlmContentPart } from "../llm/client.js";
import {
  EXTRACT_SYSTEM,
  NORMALIZE_SYSTEM,
  TRIAGE_SYSTEM,
} from "../llm/prompts.js";
import {
  ExtractionDraftSchema,
  validateGraphIntegrity,
  type ExtractionDraft,
} from "../schema/workflow.js";
import type { InputPayload } from "../io/input.js";

export const TriageResultSchema = z.object({
  isWorkflow: z.boolean(),
  /** Shown to the end user, especially on rejection. */
  reason: z.string(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

/** Build the user content parts for a stage that consumes the raw input. */
function rawInputParts(input: InputPayload, instruction: string): LlmContentPart[] {
  if (input.kind === "image") {
    return [
      { type: "image", mediaType: input.mediaType, base64: input.base64 },
      { type: "text", text: `${instruction} The input is the image above.` },
    ];
  }
  return [{ type: "text", text: `${instruction}\n\nInput:\n${input.text}` }];
}

/** Stage 1 — classify the input; non-workflows are rejected gracefully upstream. */
export async function triageInput(
  llm: LlmClient,
  input: InputPayload,
): Promise<TriageResult> {
  return llm.structured({
    system: TRIAGE_SYSTEM,
    user: rawInputParts(input, "Decide whether this input is a workflow."),
    schema: TriageResultSchema,
    taskLabel: "triage",
  });
}

const NormalizeResultSchema = z.object({
  /** The complete graph-shaped text intermediate. */
  intermediate: z.string(),
});

/** Stage 2 — normalize any modality to the edge-list text intermediate. */
export async function normalizeToIntermediate(
  llm: LlmClient,
  input: InputPayload,
): Promise<string> {
  const result = await llm.structured({
    system: NORMALIZE_SYSTEM,
    user: rawInputParts(
      input,
      "Convert this workflow into the graph-shaped text intermediate.",
    ),
    schema: NormalizeResultSchema,
    taskLabel: "normalization",
    semanticCheck: (value) =>
      value.intermediate.trim() === ""
        ? ["the intermediate text is empty"]
        : [],
  });
  return result.intermediate;
}

/**
 * Stage 3 — extract the structured draft from the intermediate. Unknown
 * fields come back null; graph integrity (unique ids, no dangling edges) is
 * enforced through the repair loop via `validateGraphIntegrity`.
 */
export async function extractDraft(
  llm: LlmClient,
  intermediate: string,
): Promise<ExtractionDraft> {
  return llm.structured({
    system: EXTRACT_SYSTEM,
    user: [
      {
        type: "text",
        text: `Intermediate workflow representation:\n\n${intermediate}`,
      },
    ],
    schema: ExtractionDraftSchema,
    taskLabel: "extraction",
    semanticCheck: validateGraphIntegrity,
  });
}
