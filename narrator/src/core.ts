/**
 * The browser-safe public API: everything `index.ts` exports except
 * `io/workflow.ts`, which finds a sibling preprocessor result on disk
 * (`node:fs`). The pipeline never needs that module — it hands the schema
 * over directly — so a bundler targeting the browser consumes this entry.
 *
 * Importable as `workflow-narrator/core`. `workflow-narrator` (the root)
 * re-exports all of this plus the file-resolution helpers, so Node callers
 * are unaffected.
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
