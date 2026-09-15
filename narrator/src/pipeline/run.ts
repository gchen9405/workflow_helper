/**
 * The orchestrator. Wires the stages together and enforces the terminal-
 * state guarantee:
 *
 *   EVERY input terminates in exactly one of three states —
 *     1. `complete` — report with the requested summary layer on top;
 *     2. `fallback` — report with the deterministic summary because the
 *                     model's summary was unavailable (reason recorded);
 *     3. `notice`   — the recommender result was unsuitable; the report
 *                     explains why and what to do next.
 *
 * Pipeline order (LLM stage marked):
 *   load → render the deterministic body → [SUMMARY (the only LLM call)]
 *   → assemble.
 *
 * The body is rendered BEFORE the model is called and is passed to it
 * verbatim: the model summarizes exactly the text the reader gets, and the
 * grounding check compares its output against the same result the body
 * came from. Any failure of the model call — refusal, repair loop
 * exhausted, HTTP or network error — degrades to the deterministic summary
 * rather than losing the report: the model layer only ever adds.
 */
import type { LlmClient, Workflow } from "workflow-preprocessor/core";
import {
  LlmHttpError,
  LlmRefusalError,
  LlmRepairExhaustedError,
} from "workflow-preprocessor/core";
import { STARTER_CATALOG, type PatternDef } from "workflow-recommender";
import { hasBody, loadRecommendation } from "../schema/input.js";
import type { Narration, NarrationSource, SummaryBlock } from "../schema/narration.js";
import { assembleReport, renderBody, type ReportContext } from "../render/report.js";
import { deterministicSummary, renderSummarySection } from "../render/summary.js";
import { collectFacts, summarize } from "../llm/summary.js";

export const DEFAULT_TOP = 5;

export interface NarratorRunOptions {
  /**
   * The preprocessor result's workflow, for step names, flow order, and
   * branch labels. Resolve it with `resolveWorkflow()` (file lookup) or
   * `workflowFromPreprocessResult()` (JSON in hand). Omit to refer to steps
   * by id.
   */
  workflow?: Workflow | null;
  /** Recorded in the title line when the workflow came from a file. */
  workflowPath?: string | null;
  /** The catalog the result was produced against. Default: the starter catalog. */
  catalog?: PatternDef[];
  /** Opportunities written up in full (default 5); the rest are tabulated. */
  top?: number;
  /** How the input is referred to in the title line (its file name, usually). */
  inputLabel?: string;
}

function describeFailure(err: unknown): string {
  if (err instanceof LlmRefusalError) return "the model declined to summarize the report";
  if (err instanceof LlmRepairExhaustedError) {
    return `the model's summary failed the grounding check repeatedly (${err.errors.join("; ")})`;
  }
  if (err instanceof LlmHttpError) return `the LLM endpoint returned HTTP ${err.status}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Narrate a recommender result. Pass `llm: null` for the deterministic
 * report alone (no model call is made, and the status is still `complete`
 * — that is the requested layer).
 */
export async function narrate(
  llm: LlmClient | null,
  input: unknown,
  options: NarratorRunOptions = {},
): Promise<Narration> {
  const result = loadRecommendation(input);
  const ctx: ReportContext = {
    result,
    workflow: options.workflow ?? null,
    workflowPath: options.workflowPath ?? null,
    catalog: options.catalog ?? STARTER_CATALOG,
    top: options.top ?? DEFAULT_TOP,
    inputLabel: options.inputLabel ?? "recommendations.json",
  };
  const body = renderBody(ctx);
  const source: NarrationSource = {
    inputLabel: ctx.inputLabel,
    recommenderStatus: result.status,
    workflowName: hasBody(result) ? result.workflowName : null,
    workflowPath: ctx.workflowPath,
  };

  if (!hasBody(result)) {
    return { status: "notice", report: assembleReport(ctx, null, body), body, summary: null, source };
  }

  const fallback = deterministicSummary(ctx, result);
  let summary: SummaryBlock;
  let status: Narration["status"];
  if (llm === null) {
    summary = { kind: "deterministic", reason: "no model summary was requested", ...fallback };
    status = "complete";
  } else {
    try {
      const model = await summarize(llm, body, collectFacts(result), {
        workflowName: result.workflowName,
        status: result.status,
      });
      summary = { kind: "model", ...model };
      status = "complete";
    } catch (err) {
      summary = {
        kind: "deterministic",
        reason: `the model summary was unavailable: ${describeFailure(err)}`,
        ...fallback,
      };
      status = "fallback";
    }
  }

  return {
    status,
    report: assembleReport(ctx, renderSummarySection(summary), body),
    body,
    summary,
    source,
  };
}
