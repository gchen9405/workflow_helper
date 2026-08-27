/**
 * THE ONLY LLM STAGE in the narrator: the summary on top of the
 * deterministic body.
 *
 * The model receives the body (the exact Markdown the reader will see
 * below the summary) and returns the five summary slots as structured
 * output. Grounding is enforced client-side by {@link checkSummary} as a
 * `semanticCheck`, so a summary that cites a score no recommendation has,
 * leaks an internal id, or runs long goes back to the model through the
 * client's machine repair loop — the reader never sees it. If the loop is
 * exhausted (or the endpoint declines/fails), the caller falls back to the
 * deterministic summary; the model can only ever ADD to the report.
 */
import { z } from "zod";
import type { LlmClient } from "workflow-preprocessor";
import type { NarratableRecommendation } from "../schema/input.js";
import { wordCount } from "../render/phrases.js";
import { SUMMARY_SYSTEM } from "./prompts.js";

export const OVERVIEW_MAX_WORDS = 250;
export const HEADLINE_MAX_WORDS = 24;

export const SummarySchema = z.object({
  headline: z
    .string()
    .min(1)
    .describe("One sentence, at most 20 words, stating the main conclusion."),
  overview: z
    .string()
    .min(1)
    .describe(
      "Two to four short paragraphs of plain prose separated by blank lines, under 250 words: the top recommendations, where they apply, why they rank there, and how sure the report is.",
    ),
  takeaways: z
    .array(z.string().min(1))
    .min(1)
    .max(6)
    .describe("One to six single-sentence takeaways, most important first."),
  firstStep: z
    .string()
    .min(1)
    .describe("The one concrete action to start with, with its prerequisites, in one or two sentences."),
  caveats: z
    .array(z.string().min(1))
    .max(5)
    .describe(
      "Up to five single-sentence caveats: confidence limits, assumed values, open questions, exclusions. Empty when the report states none.",
    ),
});
export type ModelSummary = z.infer<typeof SummarySchema>;

/** What the grounding check compares the model's text against. */
export interface SummaryFacts {
  /** Every opportunity's total score. */
  totals: number[];
}

export function collectFacts(result: NarratableRecommendation): SummaryFacts {
  return { totals: result.opportunities.map((o) => o.score.total) };
}

const SCORE_MENTION = /\b(\d{1,3})\s*(?:\/|out of)\s*100\b/g;
const INTERNAL_ID = /\b(?:pat|motif)\.[a-z0-9_]+/g;
const HEADING = /(^|\n)\s*#{1,6}\s/;

function fields(summary: ModelSummary): Array<[string, string]> {
  return [
    ["headline", summary.headline],
    ["overview", summary.overview],
    ...summary.takeaways.map((t, i): [string, string] => [`takeaways[${i}]`, t]),
    ["firstStep", summary.firstStep],
    ...summary.caveats.map((c, i): [string, string] => [`caveats[${i}]`, c]),
  ];
}

/**
 * Grounding and shape rules the schema cannot express, as repair-loop error
 * strings. Empty means the summary is acceptable.
 */
export function checkSummary(summary: ModelSummary, facts: SummaryFacts): string[] {
  const errors: string[] = [];
  const totals = new Set(facts.totals);

  for (const [name, text] of fields(summary)) {
    for (const match of text.matchAll(SCORE_MENTION)) {
      const n = Number(match[1]);
      if (!totals.has(n)) {
        errors.push(
          `${name} cites a score of ${n}/100, but no recommendation in the report has that score — quote only scores that appear in the report` +
            (facts.totals.length > 0 ? ` (${[...totals].map((t) => `${t}/100`).join(", ")})` : ""),
        );
      }
    }
    for (const match of text.matchAll(INTERNAL_ID)) {
      errors.push(`${name} uses the internal identifier "${match[0]}" — refer to recommendations and shapes by the names the report uses`);
    }
    if (HEADING.test(text)) {
      errors.push(`${name} contains a markdown heading — plain prose only`);
    }
  }

  const overviewWords = wordCount(summary.overview);
  if (overviewWords > OVERVIEW_MAX_WORDS) {
    errors.push(`overview is ${overviewWords} words — keep it under ${OVERVIEW_MAX_WORDS}`);
  }
  const headlineWords = wordCount(summary.headline);
  if (headlineWords > HEADLINE_MAX_WORDS) {
    errors.push(`headline is ${headlineWords} words — one sentence of at most 20 words`);
  }
  return errors;
}

export interface SummaryContext {
  workflowName: string | null;
  status: "recommended" | "partial";
}

/**
 * Ask the model for the summary of `body`. Throws the client's errors
 * (`LlmRefusalError`, `LlmRepairExhaustedError`, HTTP/network errors)
 * upward — the orchestrator maps every one of them to the deterministic
 * fallback.
 */
export async function summarize(
  llm: LlmClient,
  body: string,
  facts: SummaryFacts,
  context: SummaryContext,
): Promise<ModelSummary> {
  const scores = facts.totals.length > 0 ? facts.totals.map((t) => `${t}/100`).join(", ") : "none";
  const user = [
    `Workflow: ${context.workflowName ?? "(unnamed)"}`,
    `Recommender status: ${context.status}`,
    `Recommendations in the report: ${facts.totals.length} (scores, best first: ${scores})`,
    "",
    "The report body follows. Write its opening summary.",
    "",
    "<report>",
    body,
    "</report>",
  ].join("\n");

  return llm.structured({
    system: SUMMARY_SYSTEM,
    user: [{ type: "text", text: user }],
    schema: SummarySchema,
    taskLabel: "summary",
    semanticCheck: (value) => checkSummary(value, facts),
  });
}
