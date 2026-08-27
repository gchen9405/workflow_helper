/**
 * The input boundary: validating a recommender result JSON into a typed
 * value the renderer can trust.
 *
 * The recommender exports TypeScript types for `RecommendationResult` but no
 * runtime Zod schema for the envelope, so — exactly as the recommender does
 * with the preprocessor's envelope — the shape is validated locally, with
 * this package's own zod instance. The closed vocabularies (task classes,
 * scales, deployments, motif kinds) are imported from the recommender as
 * plain arrays, so an enum drift between the two packages is caught here at
 * load time rather than surfacing as "undefined" in a report.
 *
 * Validation is deliberately tolerant of ADDITIONS: unknown keys are
 * stripped, and fields the recommender may grow later default to empty.
 * What it is strict about is everything the report quotes — ids, names,
 * scores, confidence, explanations — because the deterministic body is the
 * ground truth the model summary is checked against.
 */
import { z } from "zod";
import {
  ACTOR_KINDS,
  DEPLOYMENTS,
  DURATIONS,
  EFFORTS,
  ERROR_PRONENESS,
  FREQUENCIES,
  JUDGMENTS,
  MOTIF_KINDS,
  SENSITIVITIES,
  STRUCTURES,
  TASK_CLASSES,
} from "workflow-recommender";

const attr = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.object({
    value: z.enum(values).nullable(),
    basis: z.enum(["explicit", "implied"]).nullable(),
    evidence: z.string().nullable(),
  });

export const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), nodeId: z.string() }),
  z.object({ kind: z.literal("motif"), motifId: z.string() }),
]);
export type LoadedTarget = z.infer<typeof TargetSchema>;

const VariantSchema = z.object({
  variantId: z.string(),
  name: z.string(),
  deployment: z.enum(DEPLOYMENTS),
  effort: z.enum(EFFORTS),
  sensitivityCeiling: z.enum(SENSITIVITIES),
});
export type LoadedVariant = z.infer<typeof VariantSchema>;

const ScoreSchema = z.object({
  impact: z.number(),
  feasibility: z.number(),
  constraint: z.number(),
  total: z.number(),
  factors: z.object({
    frequency: z.number(),
    duration: z.number(),
    errorBonus: z.number(),
    structure: z.number(),
    judgment: z.number(),
    sensitivityFriction: z.number(),
    effortFactor: z.number(),
    sequenceDiscount: z.number(),
  }),
});

const OpportunitySchema = z.object({
  id: z.string(),
  target: TargetSchema,
  patternId: z.string(),
  sequence: z.array(z.object({ order: z.number(), patternId: z.string() })).min(1),
  variants: z.array(VariantSchema).min(1),
  score: ScoreSchema,
  confidence: z.enum(["high", "medium", "low"]),
  confidenceReasons: z.array(z.string()),
  affectedBy: z.array(z.string()).default([]),
  explanation: z.string(),
  adviceRefs: z.array(z.string()).default([]),
});
export type LoadedOpportunity = z.infer<typeof OpportunitySchema>;

const ProfileSchema = z.object({
  nodeId: z.string(),
  taskClass: attr(TASK_CLASSES),
  attributes: z.object({
    frequency: attr(FREQUENCIES),
    duration: attr(DURATIONS),
    structure: attr(STRUCTURES),
    judgment: attr(JUDGMENTS),
    dataSensitivity: attr(SENSITIVITIES),
    actorKind: attr(ACTOR_KINDS),
    errorProneness: attr(ERROR_PRONENESS),
  }),
});
export type LoadedProfile = z.infer<typeof ProfileSchema>;

const MotifSchema = z.object({
  id: z.string(),
  kind: z.enum(MOTIF_KINDS),
  nodeIds: z.array(z.string()),
  edgeIds: z.array(z.string()).default([]),
  evidence: z.string(),
});
export type LoadedMotif = z.infer<typeof MotifSchema>;

/** Questions are kept to the two fields every report needs. */
const QuestionSchema = z.object({ id: z.string(), text: z.string() });
export type LoadedQuestion = z.infer<typeof QuestionSchema>;

const RoundSchema = z.object({
  round: z.number(),
  questions: z.array(QuestionSchema),
  answers: z.array(z.object({ questionId: z.string(), answer: z.string() })),
  applied: z.array(z.unknown()).default([]),
});

const ExcludedSchema = z.object({
  patternId: z.string(),
  target: TargetSchema,
  reason: z.string(),
});
export type LoadedExcluded = z.infer<typeof ExcludedSchema>;

const BodySchema = z.object({
  source: z.object({
    path: z.string().optional(),
    preprocessStatus: z.enum(["validated", "partial"]),
  }),
  workflowName: z.string().nullable(),
  profiles: z.array(ProfileSchema),
  skippedNodes: z.array(z.object({ nodeId: z.string(), why: z.string() })).default([]),
  motifs: z.array(MotifSchema).default([]),
  opportunities: z.array(OpportunitySchema),
  excluded: z.array(ExcludedSchema).default([]),
  provenance: z.record(z.string(), z.enum(["original", "inferred", "user_elicited"])).default({}),
  inputProvenance: z.record(z.string(), z.string()).default({}),
  rounds: z.array(RoundSchema).default([]),
  inheritedOpenQuestions: z.array(QuestionSchema).default([]),
});
export type LoadedBody = z.infer<typeof BodySchema>;

const EnvelopeSchema = z.discriminatedUnion("status", [
  BodySchema.extend({ status: z.literal("recommended") }),
  BodySchema.extend({
    status: z.literal("partial"),
    reason: z.string(),
    openQuestions: z.array(QuestionSchema),
  }),
  z.object({ status: z.literal("unsuitable"), reason: z.string() }),
]);

export type LoadedRecommendation = z.infer<typeof EnvelopeSchema>;
/** The two statuses that carry a body to narrate. */
export type NarratableRecommendation = Exclude<LoadedRecommendation, { status: "unsuitable" }>;

/**
 * Validate parsed JSON into a typed recommender result. Throws an Error with
 * a readable message when the value is not a recommender result — the CLI
 * maps that to exit code 1 (a usage problem, not a terminal state).
 */
export function loadRecommendation(json: unknown): LoadedRecommendation {
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? ` (${first.path.map(String).join(".") || "root"}: ${first.message})` : "";
    throw new Error(
      "not a recommender result JSON (expected status recommended/partial/unsuitable " +
        `with a recommendation body)${where} — generate one with workflow-recommender first`,
    );
  }
  return parsed.data;
}

export function hasBody(result: LoadedRecommendation): result is NarratableRecommendation {
  return result.status !== "unsuitable";
}
