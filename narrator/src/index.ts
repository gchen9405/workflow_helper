/**
 * Public API of the workflow narrator.
 *
 * Typical library usage:
 *
 * ```ts
 * import { createLlmClient } from "workflow-preprocessor";
 * import { narrate, workflowFromPreprocessResult } from "workflow-narrator";
 *
 * const narration = await narrate(
 *   createLlmClient(), // reads LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL; or null for no model summary
 *   JSON.parse(readFileSync("re.recommendations.json", "utf8")),
 *   { workflow: workflowFromPreprocessResult(JSON.parse(readFileSync("re.json", "utf8"))) },
 * );
 * // narration.status is "complete" | "fallback" | "notice"; narration.report is Markdown
 * ```
 */

// Input boundary
export {
  loadRecommendation,
  hasBody,
  TargetSchema,
  type LoadedRecommendation,
  type NarratableRecommendation,
  type LoadedBody,
  type LoadedOpportunity,
  type LoadedProfile,
  type LoadedMotif,
  type LoadedTarget,
  type LoadedVariant,
  type LoadedExcluded,
  type LoadedQuestion,
} from "./schema/input.js";
export {
  resolveWorkflow,
  siblingWorkflowPath,
  workflowFromPreprocessResult,
  RECOMMENDATIONS_SUFFIX,
  type ResolvedWorkflow,
  type ResolveWorkflowOptions,
} from "./io/workflow.js";

// Result
export type {
  Narration,
  NarrationSource,
  SummaryBlock,
  SummaryContent,
} from "./schema/narration.js";

// Deterministic rendering
export {
  renderBody,
  renderTitle,
  assembleReport,
  flowOrder,
  detailCount,
  stepRef,
  targetRef,
  type ReportContext,
} from "./render/report.js";
export { deterministicSummary, renderSummarySection } from "./render/summary.js";
export * from "./render/phrases.js";

// LLM stage
export {
  summarize,
  checkSummary,
  collectFacts,
  SummarySchema,
  OVERVIEW_MAX_WORDS,
  HEADLINE_MAX_WORDS,
  type ModelSummary,
  type SummaryFacts,
  type SummaryContext,
} from "./llm/summary.js";
export { SUMMARY_SYSTEM } from "./llm/prompts.js";

// Orchestration
export { narrate, DEFAULT_TOP, type NarratorRunOptions } from "./pipeline/run.js";
