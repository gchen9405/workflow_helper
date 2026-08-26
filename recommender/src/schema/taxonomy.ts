/**
 * The closed vocabularies everything else is built on: the task taxonomy and
 * the per-task attribute scales.
 *
 * Two design rules govern this file:
 *
 * 1. CLOSED SETS ONLY. The single LLM stage (`../pipeline/profile.ts`)
 *    classifies free text INTO these enums; every stage after that — gap
 *    detection, matching, scoring — is deterministic code over enum values.
 *    Growing a vocabulary means editing this file, and the catalog compiles
 *    against it, so a typo'd class is a type error, not a silent mismatch.
 *
 * 2. ORDINALS SCORE THROUGH MAPS. Every ordered scale exports a
 *    `<NAME>_SCORE` map; scoring and gate evaluation only ever compare those
 *    numbers, never the strings. Higher always means "more of the thing the
 *    scale is named after" — except `judgment`, which is deliberately
 *    inverted (higher = LESS judgment required) so that for every scale used
 *    in feasibility, a higher score means "easier to automate".
 *
 * The taxonomy spans back-office operations AND research/engineering
 * knowledge work (see `research_gathering` … `tool_integration`) — the
 * project's target workflows include pipelines like "collect papers →
 * distill knowledge → expose to an AI agent → verify with benchmarks",
 * not just invoice-and-approval flows. `other` is the explicit escape
 * hatch: the profiler is told to use it rather than force a bad fit.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Task taxonomy
// ---------------------------------------------------------------------------

export const TASK_CLASSES = [
  "data_entry",
  "data_extraction",
  "data_transfer",
  "document_generation",
  "document_review",
  "classification_routing",
  "approval_decision",
  "verification_check",
  "calculation",
  "scheduling_coordination",
  "communication_notification",
  "communication_drafting",
  "information_lookup",
  "summarization_reporting",
  "quality_inspection",
  "physical_task",
  "system_operation",
  "monitoring_watching",
  "archiving_records",
  "customer_interaction",
  "planning_analysis",
  "research_gathering",
  "knowledge_distillation",
  "evaluation_benchmarking",
  "tool_integration",
  "other",
] as const;

export const TaskClassSchema = z.enum(TASK_CLASSES);
export type TaskClass = z.infer<typeof TaskClassSchema>;

/**
 * One-line definitions, used verbatim in the profiling prompt so the model
 * and the humans reading the catalog share the same reading of each class.
 */
export const TASK_CLASS_DEFINITIONS: Record<TaskClass, string> = {
  data_entry: "typing or keying information into a system or form",
  data_extraction: "pulling specific values out of documents, messages, or systems",
  data_transfer: "moving or copying data between systems, files, or formats",
  document_generation: "producing a document, contract, or report from inputs",
  document_review: "reading a document to assess, correct, or annotate it",
  classification_routing: "categorizing items or deciding where/to whom they go",
  approval_decision: "authorizing, signing off, or accepting/rejecting a request",
  verification_check: "checking facts, figures, or work against a reference",
  calculation: "computing amounts, totals, or other derived values",
  scheduling_coordination: "arranging times, resources, or people",
  communication_notification: "informing someone that something happened (status, confirmation)",
  communication_drafting: "composing substantive messages or correspondence",
  information_lookup: "finding a specific piece of information someone needs",
  summarization_reporting: "condensing information into a summary or recurring report",
  quality_inspection: "examining a product or output for defects",
  physical_task: "manual physical work (picking, packing, moving, repairing)",
  system_operation: "operating or administering software systems (runs, deploys, configs)",
  monitoring_watching: "keeping an eye on a feed, queue, dashboard, or inbox",
  archiving_records: "filing, storing, or retaining records",
  customer_interaction: "live interaction with a customer or external party",
  planning_analysis: "analyzing options and deciding a course of action",
  research_gathering: "collecting sources, literature, datasets, or existing tools",
  knowledge_distillation: "curating or condensing collected knowledge into a usable form",
  evaluation_benchmarking: "running evaluations, benchmarks, or human studies on an output",
  tool_integration: "wiring systems, harnesses, or pipeline components together",
  other: "none of the above fits",
};

// ---------------------------------------------------------------------------
// Attribute scales (ordinal unless noted)
// ---------------------------------------------------------------------------

/** How often the task is performed. */
export const FREQUENCIES = ["ad_hoc", "monthly", "weekly", "daily", "many_per_day"] as const;
export const FrequencySchema = z.enum(FREQUENCIES);
export type Frequency = z.infer<typeof FrequencySchema>;
export const FREQUENCY_SCORE: Record<Frequency, number> = {
  ad_hoc: 1,
  monthly: 2,
  weekly: 3,
  daily: 4,
  many_per_day: 5,
};

/** How long one run of the task takes. */
export const DURATIONS = [
  "under_5_min",
  "5_to_30_min",
  "30_min_to_2_h",
  "2_h_to_1_day",
  "multi_day",
] as const;
export const DurationSchema = z.enum(DURATIONS);
export type Duration = z.infer<typeof DurationSchema>;
export const DURATION_SCORE: Record<Duration, number> = {
  under_5_min: 1,
  "5_to_30_min": 2,
  "30_min_to_2_h": 3,
  "2_h_to_1_day": 4,
  multi_day: 5,
};

/** How completely the task could be described as explicit rules. */
export const STRUCTURES = [
  "case_by_case",
  "guidelines_with_exceptions",
  "mostly_rules",
  "fully_rule_based",
] as const;
export const StructureSchema = z.enum(STRUCTURES);
export type Structure = z.infer<typeof StructureSchema>;
export const STRUCTURE_SCORE: Record<Structure, number> = {
  case_by_case: 1,
  guidelines_with_exceptions: 2,
  mostly_rules: 3,
  fully_rule_based: 4,
};

/**
 * The level of human judgment the task REQUIRES. Inverted scale: a higher
 * score means less judgment is needed, so — like structure — higher is
 * easier to automate.
 */
export const JUDGMENTS = ["expert", "experienced", "routine", "none"] as const;
export const JudgmentSchema = z.enum(JUDGMENTS);
export type Judgment = z.infer<typeof JudgmentSchema>;
export const JUDGMENT_SCORE: Record<Judgment, number> = {
  expert: 1,
  experienced: 2,
  routine: 3,
  none: 4,
};

/** Sensitivity of the data the task touches. Acts as a HARD FILTER on variants. */
export const SENSITIVITIES = ["public", "internal", "confidential", "regulated"] as const;
export const SensitivitySchema = z.enum(SENSITIVITIES);
export type Sensitivity = z.infer<typeof SensitivitySchema>;
export const SENSITIVITY_SCORE: Record<Sensitivity, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
  regulated: 4,
};

/**
 * Who or what performs the task today. Not ordinal. `ai_agent` is
 * first-class because target workflows can already contain AI-performed
 * steps — AI-adoption patterns gate on {human, mixed} so they never
 * recommend adding AI to a step an AI already performs.
 */
export const ACTOR_KINDS = ["human", "system", "ai_agent", "mixed"] as const;
export const ActorKindSchema = z.enum(ACTOR_KINDS);
export type ActorKind = z.infer<typeof ActorKindSchema>;

/** How often the task goes wrong today. Optional enrichment — never a gap. */
export const ERROR_PRONENESS = ["rare", "occasional", "frequent"] as const;
export const ErrorPronenessSchema = z.enum(ERROR_PRONENESS);
export type ErrorProneness = z.infer<typeof ErrorPronenessSchema>;
/** Scored as an impact BONUS (added to frequency×duration), hence 0-based. */
export const ERROR_BONUS: Record<ErrorProneness, number> = {
  rare: 0,
  occasional: 1,
  frequent: 2,
};
