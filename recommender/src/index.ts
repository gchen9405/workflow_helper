/**
 * Public API of the workflow recommender.
 *
 * Typical library usage:
 *
 * ```ts
 * import { createLlmClient, silentIO } from "workflow-preprocessor";
 * import { runRecommender } from "workflow-recommender";
 *
 * const result = await runRecommender(
 *   createLlmClient(), // reads LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL
 *   JSON.parse(readFileSync("order-fulfillment.json", "utf8")),
 *   silentIO, // or any { askBatch } implementation for interactive runs
 * );
 * // result.status is "recommended" | "partial" | "unsuitable"
 * ```
 */

// Vocabulary
export {
  TASK_CLASSES,
  TASK_CLASS_DEFINITIONS,
  TaskClassSchema,
  FREQUENCIES,
  FREQUENCY_SCORE,
  DURATIONS,
  DURATION_SCORE,
  STRUCTURES,
  STRUCTURE_SCORE,
  JUDGMENTS,
  JUDGMENT_SCORE,
  SENSITIVITIES,
  SENSITIVITY_SCORE,
  ACTOR_KINDS,
  ERROR_PRONENESS,
  ERROR_BONUS,
  type TaskClass,
  type Frequency,
  type Duration,
  type Structure,
  type Judgment,
  type Sensitivity,
  type ActorKind,
  type ErrorProneness,
} from "./schema/taxonomy.js";

// Profiles + provenance
export {
  NodeProfileSchema,
  ProfileDraftSchema,
  ATTRIBUTE_NAMES,
  REQUIRED_ATTRIBUTES,
  profilePath,
  stampProfileProvenance,
  checkProfileDraft,
  type AttrValue,
  type Basis,
  type NodeProfile,
  type ProfileDraft,
  type AttributeName,
  type RequiredAttribute,
  type RecommenderProvenance,
} from "./schema/profile.js";

// Catalog
export {
  PatternDefSchema,
  PatternVariantSchema,
  ApplicabilitySchema,
  AUTOMATION_CLASSES,
  DEPLOYMENTS,
  EFFORTS,
  EFFORT_FACTOR,
  validateCatalog,
  type PatternDef,
  type PatternVariant,
  type Applicability,
  type AutomationClass,
  type Deployment,
  type Effort,
  type FeasibilityWeights,
} from "./schema/catalog.js";
export { STARTER_CATALOG } from "./catalog/patterns.js";

// Motifs
export { MOTIF_KINDS, MotifKindSchema, motifId, type Motif, type MotifKind } from "./schema/motif.js";

// Input boundary
export {
  loadPreprocessResult,
  readGapNodeIds,
  type LoadedPreprocessResult,
  type InheritedQuestion,
} from "./schema/input.js";

// Result
export {
  targetId,
  type RecommendationResult,
  type RecommendationBody,
  type Opportunity,
  type OpportunityTarget,
  type ScoreBreakdown,
  type Confidence,
  type SequenceStep,
  type SurvivingVariant,
  type ExcludedOpportunity,
  type SkippedNode,
  type RecommenderRound,
} from "./schema/result.js";

// Deterministic analyses
export { detectProfileGaps, profileGapId, type ProfileGap } from "./pipeline/gaps.js";
export {
  buildProfileQuestions,
  questionOptions,
  displayToken,
  DEFAULT_MAX_QUESTIONS_PER_ROUND,
  WORKFLOW_SENSITIVITY_QUESTION_ID,
  type ProfileQuestion,
  type QuestionSubject,
} from "./pipeline/questions.js";
export { applyAnswers, parseChoice, type AppliedAnswer } from "./pipeline/answers.js";
export { detectMotifs } from "./pipeline/motifs.js";
export {
  buildCandidates,
  matchCatalog,
  effectiveValues,
  type CandidateTarget,
  type KnownAttributes,
  type Match,
  type MatchOutcome,
  type EffectiveValues,
} from "./pipeline/match.js";
export { buildOpportunities, type ScoringContext } from "./pipeline/score.js";

// LLM stage
export { profileNodes, MAX_NODES_PER_CALL, type WorkflowContext } from "./pipeline/profile.js";
export { PROFILE_SYSTEM } from "./llm/prompts.js";

// Orchestration
export {
  runRecommender,
  DEFAULT_MAX_ROUNDS,
  type RecommenderClarificationIO,
  type RecommenderRunOptions,
} from "./pipeline/run.js";
