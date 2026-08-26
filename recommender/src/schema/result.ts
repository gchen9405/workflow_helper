/**
 * The recommender's output — a terminal-state union mirroring the
 * preprocessor's guarantee:
 *
 *   EVERY input terminates in exactly one of three states —
 *     1. `recommended` — every attribute gap was closed; full-confidence body;
 *     2. `partial`     — recommendations WERE still produced, but some
 *                        attributes stayed unknown (scored conservatively,
 *                        confidence lowered) and the remaining questions are
 *                        listed;
 *     3. `unsuitable`  — nothing to recommend on: the preprocessor rejected
 *                        the input, the workflow has no task/decision nodes,
 *                        or profiling failed before any profile existed.
 *
 * The key difference from the preprocessor: gaps never block
 * recommendations. `partial` carries the same fully ranked body as
 * `recommended` — unknowns take conservative values and show up in
 * `confidenceReasons`, and `openQuestions` says exactly what would sharpen
 * the answer.
 *
 * Every opportunity is EXPLAINABLE BY CONSTRUCTION: the score decomposes
 * into named factors, the explanation is deterministically templated from
 * those factors plus provenance, exclusions are listed with reasons, and
 * pattern ids are stable — the keying surface the future lessons-learned
 * component (`adviceRefs`) builds on.
 */
import type { Question } from "workflow-preprocessor";
import type { NodeProfile, RecommenderProvenance } from "./profile.js";
import type { Deployment, Effort } from "./catalog.js";
import type { Sensitivity } from "./taxonomy.js";
import type { Motif } from "./motif.js";
import type { ProfileQuestion } from "../pipeline/questions.js";
import type { AppliedAnswer } from "../pipeline/answers.js";

export type OpportunityTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "motif"; motifId: string };

/** Render a target as the stable string used in opportunity ids. */
export function targetId(target: OpportunityTarget): string {
  return target.kind === "node" ? target.nodeId : target.motifId;
}

export interface SequenceStep {
  order: number;
  patternId: string;
}

/** A variant that survived the sensitivity hard filter, effort-ranked. */
export interface SurvivingVariant {
  variantId: string;
  name: string;
  deployment: Deployment;
  effort: Effort;
  sensitivityCeiling: Sensitivity;
}

export interface ScoreBreakdown {
  /** Frequency × duration (+ error bonus), normalized to 0..1. */
  impact: number;
  /** How automatable the target is for this pattern, 0..1. */
  feasibility: number;
  /** Effort and sensitivity friction, 0..1 (1 = frictionless). */
  constraint: number;
  /** round(100 × impact × feasibility × constraint). */
  total: number;
  /** Every input value, by name — nothing in the score is untraceable. */
  factors: {
    /** Ordinal scores actually used (after conservative substitution). */
    frequency: number;
    duration: number;
    errorBonus: number;
    structure: number;
    judgment: number;
    /** Multipliers. */
    sensitivityFriction: number;
    effortFactor: number;
    /** 0.9 for two-step sequences, 1 otherwise. */
    sequenceDiscount: number;
  };
}

export type Confidence = "high" | "medium" | "low";

export interface Opportunity {
  /** `<patternId>@<targetId>` — unique and stable within a workflow. */
  id: string;
  target: OpportunityTarget;
  /** The destination pattern (the last step, for sequences). */
  patternId: string;
  /** Ordered steps; length 1 normally, 2 for "first X, then Y". */
  sequence: SequenceStep[];
  /** Survivors of the sensitivity hard filter, best (lowest effort) first. */
  variants: SurvivingVariant[];
  score: ScoreBreakdown;
  confidence: Confidence;
  /** Why confidence is what it is — every substitution and inference, named. */
  confidenceReasons: string[];
  /** Inherited preprocessor question ids touching this target's nodes. */
  affectedBy: string[];
  /** Deterministically templated, quoting values and their provenance. */
  explanation: string;
  /** Reserved for the lessons-learned component. Empty in v1. */
  adviceRefs: string[];
}

/** A pattern that matched but lost every variant to the sensitivity filter. */
export interface ExcludedOpportunity {
  patternId: string;
  target: OpportunityTarget;
  reason: string;
}

export interface SkippedNode {
  nodeId: string;
  why: "unknown_type";
}

/** One completed clarification round, kept for auditability. */
export interface RecommenderRound {
  round: number;
  questions: ProfileQuestion[];
  answers: { questionId: string; answer: string }[];
  /** The assignments deterministically parsed out of the answers. */
  applied: AppliedAnswer[];
}

export interface RecommendationBody {
  source: {
    /** The input file, when the run came from one. */
    path?: string;
    preprocessStatus: "validated" | "partial";
  };
  workflowName: string | null;
  profiles: NodeProfile[];
  /** Nodes profiling could not cover (null-typed nodes in partial inputs). */
  skippedNodes: SkippedNode[];
  motifs: Motif[];
  /** Ranked best-first; ranking is fully deterministic (see score.ts). */
  opportunities: Opportunity[];
  excluded: ExcludedOpportunity[];
  /** The recommender's own provenance (profile.* keys). */
  provenance: Record<string, RecommenderProvenance>;
  /** The preprocessor's provenance, echoed untouched. */
  inputProvenance: Record<string, "original" | "user_elicited">;
  rounds: RecommenderRound[];
  /** Open questions inherited from a `partial` preprocessor result. */
  inheritedOpenQuestions: { id: string; text: string }[];
}

export type RecommendationResult =
  | ({ status: "recommended" } & RecommendationBody)
  | ({
      status: "partial";
      reason: string;
      /** Every attribute question still open — uncapped, per-node. */
      openQuestions: ProfileQuestion[];
    } & RecommendationBody)
  | { status: "unsuitable"; reason: string };

/** Inherited preprocessor question type re-exported for consumers. */
export type { Question as PreprocessorQuestion };
