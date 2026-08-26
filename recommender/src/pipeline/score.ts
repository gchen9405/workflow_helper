/**
 * Scoring, confidence, ranking, and explanation — all deterministic, and
 * every number traceable: nothing reaches `score.total` without appearing
 * by name in `score.factors`, and the explanation is templated from those
 * same values plus their provenance.
 *
 * Formulas (over the ordinal score maps; unknowns already substituted
 * conservatively by match.ts):
 *
 *   impact      = min(F×D + errorBonus, 25) / 25          F, D ∈ 1..5
 *   feasibility = clamp01(base + wS·(S−1)/3 + wJ·(J−1)/3) S, J ∈ 1..4
 *   constraint  = effortFactor × sensitivityFriction × sequenceDiscount
 *   total       = round(100 × impact × feasibility × constraint)
 *
 * - (base, wS, wJ) come from the pattern's `feasibilityWeights` — the
 *   catalog decides how much structure/judgment matter to each pattern
 *   (full automation leans on both; assist keeps a human in the loop, so
 *   judgment matters less; organizational patterns barely depend on either).
 * - S is the POST-IMPROVEMENT structure score for sequences.
 * - effortFactor uses the costliest step's best surviving variant; the
 *   0.9 sequenceDiscount prices in that two changes are harder than one.
 * - sensitivityFriction: public/internal 1.0, confidential 0.9,
 *   regulated 0.8 — surviving variants still carry compliance overhead.
 *
 * Confidence derives from provenance (the whole point of tracking it):
 *   low    — any conservative substitution was used, or an inherited open
 *            preprocessor question touches the target;
 *   medium — some score-relevant value was `inferred`, or the source result
 *            was `partial`;
 *   high   — everything score-relevant is `original`/`user_elicited`, the
 *            source was `validated`, nothing inherited touches the target.
 *
 * Ranking is total order — ties break by impact, feasibility,
 * motif-before-node (a motif finding spans more of the workflow), lower
 * best-variant effort, then (patternId, targetId) lexicographically, so
 * output order is stable across runs.
 */
import type { WorkflowGraph } from "workflow-preprocessor";
import { EFFORT_FACTOR, type Effort } from "../schema/catalog.js";
import {
  profilePath,
  type RecommenderProvenance,
} from "../schema/profile.js";
import type { Motif } from "../schema/motif.js";
import type { Sensitivity } from "../schema/taxonomy.js";
import {
  targetId,
  type Confidence,
  type Opportunity,
  type ScoreBreakdown,
} from "../schema/result.js";
import { readGapNodeIds, type InheritedQuestion } from "../schema/input.js";
import { effectiveValues, type Match } from "./match.js";
import { displayToken } from "./questions.js";

const SENSITIVITY_FRICTION: Record<Sensitivity, number> = {
  public: 1.0,
  internal: 1.0,
  confidential: 0.9,
  regulated: 0.8,
};

const SEQUENCE_DISCOUNT = 0.9;

const EFFORT_ORDER: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export interface ScoringContext {
  workflow: WorkflowGraph;
  motifs: Motif[];
  provenance: Record<string, RecommenderProvenance>;
  sourceStatus: "validated" | "partial";
  inheritedQuestions: InheritedQuestion[];
}

function scoreMatch(match: Match): ScoreBreakdown {
  const values = effectiveValues(match.candidate.attrs);
  const F = values.frequencyScore;
  const D = values.durationScore;
  const S = match.scoringStructureScore;
  const J = values.judgmentScore;
  const weights = match.pattern.feasibilityWeights;

  const impact = Math.min(F * D + values.errorBonus, 25) / 25;
  const feasibility = clamp01(
    weights.base + (weights.structure * (S - 1)) / 3 + (weights.judgment * (J - 1)) / 3,
  );

  // The costliest step's best surviving variant sets the plan's effort.
  const effort = match.stepBestEfforts.reduce((worst, e) =>
    EFFORT_ORDER[e] > EFFORT_ORDER[worst] ? e : worst,
  );
  const effortFactor = EFFORT_FACTOR[effort];
  const sensitivityFriction = SENSITIVITY_FRICTION[values.sensitivity];
  const sequenceDiscount = match.sequence.length > 1 ? SEQUENCE_DISCOUNT : 1;
  const constraint = effortFactor * sensitivityFriction * sequenceDiscount;
  const total = Math.round(100 * impact * feasibility * constraint);

  return {
    impact: round3(impact),
    feasibility: round3(feasibility),
    constraint: round3(constraint),
    total,
    factors: {
      frequency: F,
      duration: D,
      errorBonus: values.errorBonus,
      structure: S,
      judgment: J,
      sensitivityFriction,
      effortFactor,
      sequenceDiscount,
    },
  };
}

/** Score-relevant provenance keys for a candidate's nodes. */
function relevantKeys(nodeIds: string[]): string[] {
  const keys: string[] = [];
  for (const nodeId of nodeIds) {
    keys.push(profilePath.taskClass(nodeId));
    for (const name of [
      "frequency",
      "duration",
      "structure",
      "judgment",
      "dataSensitivity",
      "errorProneness",
    ] as const) {
      keys.push(profilePath.attr(nodeId, name));
    }
  }
  return keys;
}

function describeTarget(match: Match, ctx: ScoringContext): string {
  const target = match.candidate.target;
  if (target.kind === "node") {
    const node = ctx.workflow.nodes.find((n) => n.id === target.nodeId);
    return node?.label ? `"${node.label}" (${target.nodeId})` : `the step "${target.nodeId}"`;
  }
  const motif = ctx.motifs.find((m) => m.id === target.motifId);
  return motif ? motif.evidence : target.motifId;
}

/** Provenance wording for one attribute of a node target. */
function tag(
  ctx: ScoringContext,
  match: Match,
  attr: "frequency" | "duration" | "structure" | "judgment" | "dataSensitivity",
): string {
  if (match.candidate.target.kind === "motif") return "aggregated across the steps";
  if (match.candidate.attrs[attr] === null) return "unknown, assumed worst case";
  const key = profilePath.attr(match.candidate.target.nodeId, attr);
  switch (ctx.provenance[key]) {
    case "user_elicited":
      return "user-confirmed";
    case "inferred":
      return "inferred";
    default:
      return "from the input";
  }
}

function explain(match: Match, score: ScoreBreakdown, ctx: ScoringContext): string {
  const attrs = match.candidate.attrs;
  const f = score.factors;
  const best = match.variants[0];

  const freq = attrs.frequency ? displayToken(attrs.frequency) : "ad hoc (assumed)";
  const dur = attrs.duration ? displayToken(attrs.duration) : "under 5 minutes (assumed)";
  const err = f.errorBonus > 0 ? ` and goes wrong ${displayToken(attrs.errorProneness!)}ly` : "";
  const impactSentence =
    `Runs ${freq} (${tag(ctx, match, "frequency")}) at ${dur} per run ` +
    `(${tag(ctx, match, "duration")})${err} → impact ${score.impact}.`;

  const structureLabel = attrs.structure
    ? displayToken(attrs.structure)
    : "case by case (assumed)";
  const seqNote =
    match.sequence.length > 1
      ? ` after step 1 (${match.sequencePatterns[0].name}) raises structure`
      : "";
  const feasibilitySentence =
    `Structure: ${structureLabel} (${tag(ctx, match, "structure")}); judgment: ` +
    `${attrs.judgment ? displayToken(attrs.judgment) : "deep expert judgment (assumed)"} ` +
    `(${tag(ctx, match, "judgment")}) → feasibility ${score.feasibility}${seqNote}.`;

  const sensitivity = attrs.dataSensitivity ?? "regulated";
  const constraintSentence =
    `${displayToken(sensitivity)} data (${tag(ctx, match, "dataSensitivity")}) allows ` +
    `${match.variants.length} deployment option(s); best: ${best.name} ` +
    `(${best.effort} effort) → constraint ${score.constraint}.`;

  const plan =
    match.sequence.length > 1
      ? `First ${match.sequencePatterns[0].name}, then ${match.pattern.name}`
      : match.pattern.name;

  return `${plan} for ${describeTarget(match, ctx)}. ${impactSentence} ${feasibilitySentence} ${constraintSentence} Total ${score.total}/100.`;
}

function confidenceOf(
  match: Match,
  ctx: ScoringContext,
  affectedBy: string[],
): { confidence: Confidence; reasons: string[] } {
  const substitutions = effectiveValues(match.candidate.attrs).substitutions;
  const inferredCount = relevantKeys(match.candidate.nodeIds).filter(
    (key) => ctx.provenance[key] === "inferred",
  ).length;

  const reasons: string[] = [...substitutions];
  if (affectedBy.length > 0) {
    reasons.push(
      `open preprocessor question(s) touch this target: ${affectedBy.join(", ")}`,
    );
  }
  if (inferredCount > 0) {
    reasons.push(`${inferredCount} value(s) inferred from the step text rather than stated`);
  }
  if (ctx.sourceStatus === "partial") {
    reasons.push("the preprocessor result was partial");
  }

  const confidence: Confidence =
    substitutions.length > 0 || affectedBy.length > 0
      ? "low"
      : inferredCount > 0 || ctx.sourceStatus === "partial"
        ? "medium"
        : "high";
  return { confidence, reasons };
}

/**
 * Score, rank, and explain every match into the final opportunity list.
 */
export function buildOpportunities(matches: Match[], ctx: ScoringContext): Opportunity[] {
  const opportunities = matches.map((match): Opportunity => {
    const score = scoreMatch(match);
    const affectedBy = ctx.inheritedQuestions
      .filter((q) => readGapNodeIds(q.gap).some((id) => match.candidate.nodeIds.includes(id)))
      .map((q) => q.id);
    const { confidence, reasons } = confidenceOf(match, ctx, affectedBy);
    return {
      id: `${match.pattern.id}@${targetId(match.candidate.target)}`,
      target: match.candidate.target,
      patternId: match.pattern.id,
      sequence: match.sequence,
      variants: match.variants,
      score,
      confidence,
      confidenceReasons: reasons,
      affectedBy,
      explanation: explain(match, score, ctx),
      adviceRefs: [],
    };
  });

  return opportunities.sort(
    (a, b) =>
      b.score.total - a.score.total ||
      b.score.impact - a.score.impact ||
      b.score.feasibility - a.score.feasibility ||
      (a.target.kind === "motif" ? 0 : 1) - (b.target.kind === "motif" ? 0 : 1) ||
      EFFORT_ORDER[a.variants[0].effort] - EFFORT_ORDER[b.variants[0].effort] ||
      a.patternId.localeCompare(b.patternId) ||
      targetId(a.target).localeCompare(targetId(b.target)),
  );
}
