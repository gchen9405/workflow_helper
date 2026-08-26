/**
 * The orchestrator. Owns the state, wires the stages together, and enforces
 * the terminal-state guarantee:
 *
 *   EVERY input terminates in exactly one of three states —
 *     1. `recommended` — every attribute gap closed;
 *     2. `partial`     — recommendations still produced (conservative
 *                        substitutions, lowered confidence) + open questions;
 *     3. `unsuitable`  — nothing to recommend on, with a stated reason.
 *
 * How each exit is reached:
 *
 *   unsuitable:
 *     - the preprocessor result is `rejected` (no schema exists);
 *     - the workflow has no task/decision nodes;
 *     - profiling hits a safety refusal or exhausts the repair loop — no
 *       profile exists yet, so there is nothing honest to recommend on
 *       (the same logic as the preprocessor's pre-schema failures).
 *   recommended:
 *     - `detectProfileGaps()` (deterministic code) returns empty.
 *   partial:
 *     - the user stops or skips all remaining questions;
 *     - a round applies zero answers (nothing parsed — prevents re-asking
 *       forever);
 *     - the round cap is reached.
 *
 * Termination argument: the loop only continues when a round applied at
 * least one answer AND the counter is below the cap; the cap makes it
 * finite regardless of what the user does.
 *
 * Pipeline order (LLM stages marked):
 *   load → eligibility → PROFILE (the only LLM call) → provenance stamping
 *   → [gap detection → questions → answers]* → motifs → matching →
 *   sensitivity filter → scoring/ranking → assemble.
 * Motif detection runs AFTER the loop so detectors see final attributes.
 */
import {
  LlmRefusalError,
  LlmRepairExhaustedError,
  type BatchAnswers,
  type LlmClient,
  type Workflow,
} from "workflow-preprocessor";
import { loadPreprocessResult } from "../schema/input.js";
import {
  stampProfileProvenance,
  type NodeProfile,
  type RecommenderProvenance,
} from "../schema/profile.js";
import type { PatternDef } from "../schema/catalog.js";
import type {
  RecommendationBody,
  RecommendationResult,
  RecommenderRound,
  SkippedNode,
} from "../schema/result.js";
import { STARTER_CATALOG } from "../catalog/patterns.js";
import { profileNodes } from "./profile.js";
import { detectProfileGaps } from "./gaps.js";
import {
  buildProfileQuestions,
  DEFAULT_MAX_QUESTIONS_PER_ROUND,
  WORKFLOW_SENSITIVITY_QUESTION_ID,
  type ProfileQuestion,
} from "./questions.js";
import { applyAnswers } from "./answers.js";
import { detectMotifs } from "./motifs.js";
import { buildCandidates, matchCatalog } from "./match.js";
import { buildOpportunities } from "./score.js";

/**
 * How the pipeline talks to the user — same shape as the preprocessor's
 * `ClarificationIO`, over this component's question type. The exported
 * `ReadlineClarificationIO`/`silentIO` from workflow-preprocessor satisfy
 * it structurally.
 */
export interface RecommenderClarificationIO {
  askBatch(questions: ProfileQuestion[], round: number): Promise<BatchAnswers>;
}

export interface RecommenderRunOptions {
  /** Hard cap on clarification rounds. Guarantees termination. Default 10. */
  maxRounds?: number;
  /** Cap on questions per round. Default 8. */
  maxQuestionsPerRound?: number;
  /** Pattern catalog override; defaults to the starter catalog. */
  catalog?: PatternDef[];
  /** Recorded in the result's `source.path` when the input came from a file. */
  sourcePath?: string;
}

export const DEFAULT_MAX_ROUNDS = 10;

function isLlmFailure(err: unknown): err is LlmRefusalError | LlmRepairExhaustedError {
  return err instanceof LlmRefusalError || err instanceof LlmRepairExhaustedError;
}

export async function runRecommender(
  llm: LlmClient,
  input: unknown,
  io: RecommenderClarificationIO,
  options: RecommenderRunOptions = {},
): Promise<RecommendationResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxQuestionsPerRound =
    options.maxQuestionsPerRound ?? DEFAULT_MAX_QUESTIONS_PER_ROUND;
  const catalog = options.catalog ?? STARTER_CATALOG;

  // ---- Load + eligibility --------------------------------------------------
  const loaded = loadPreprocessResult(input);
  if (loaded.status === "rejected") {
    return {
      status: "unsuitable",
      reason: `the preprocessor rejected this input: ${loaded.reason}`,
    };
  }
  const workflow: Workflow = loaded.workflow;

  const eligible = workflow.nodes.filter((n) => n.type === "task" || n.type === "decision");
  const skippedNodes: SkippedNode[] = workflow.nodes
    .filter((n) => n.type === null)
    .map((n) => ({ nodeId: n.id, why: "unknown_type" as const }));
  if (eligible.length === 0) {
    return {
      status: "unsuitable",
      reason: "the workflow contains no task or decision steps to recommend on",
    };
  }

  // ---- Profile (the only LLM call) -----------------------------------------
  let profiles: NodeProfile[];
  try {
    profiles = await profileNodes(
      llm,
      { name: workflow.name, description: workflow.description },
      eligible,
    );
  } catch (err) {
    // No profile exists yet — refuse to fabricate recommendations.
    if (isLlmFailure(err)) {
      return {
        status: "unsuitable",
        reason: `could not profile the workflow's steps (${err.message})`,
      };
    }
    throw err;
  }
  let provenance: Record<string, RecommenderProvenance> = stampProfileProvenance(profiles);

  const rounds: RecommenderRound[] = [];
  let workflowSensitivityAsked = false;

  // ---- Assemble a terminal result (shared by every exit) -------------------
  const finalize = (partialReason: string | null): RecommendationResult => {
    const motifs = detectMotifs(workflow, profiles);
    const candidates = buildCandidates(profiles, motifs);
    const { matches, excluded } = matchCatalog(catalog, candidates);
    const opportunities = buildOpportunities(matches, {
      workflow,
      motifs,
      provenance,
      sourceStatus: loaded.status,
      inheritedQuestions: loaded.openQuestions,
    });
    const body: RecommendationBody = {
      source: {
        ...(options.sourcePath !== undefined ? { path: options.sourcePath } : {}),
        preprocessStatus: loaded.status,
      },
      workflowName: workflow.name,
      profiles,
      skippedNodes,
      motifs,
      opportunities,
      excluded,
      provenance,
      inputProvenance: workflow.provenance,
      rounds,
      inheritedOpenQuestions: loaded.openQuestions.map((q) => ({ id: q.id, text: q.text })),
    };
    if (partialReason === null) {
      return { status: "recommended", ...body };
    }
    return {
      status: "partial",
      reason: partialReason,
      // The complete per-node list of what is still unknown — uncapped, and
      // never collapsed into the workflow-level question, so it is a full
      // inventory rather than a next-round batch.
      openQuestions: buildProfileQuestions(
        workflow,
        detectProfileGaps(profiles),
        Number.POSITIVE_INFINITY,
        { workflowSensitivityAsked: true },
      ),
      ...body,
    };
  };

  // ---- Clarification loop: gaps are the termination condition --------------
  for (let round = 1; ; round++) {
    const gaps = detectProfileGaps(profiles);
    if (gaps.length === 0) return finalize(null);
    if (round > maxRounds) {
      return finalize(
        `the clarification round limit (${maxRounds}) was reached with questions still open`,
      );
    }

    const questions = buildProfileQuestions(workflow, gaps, maxQuestionsPerRound, {
      workflowSensitivityAsked,
    });
    const batch = await io.askBatch(questions, round);
    if (questions.some((q) => q.id === WORKFLOW_SENSITIVITY_QUESTION_ID)) {
      workflowSensitivityAsked = true;
    }

    const askedIds = new Set(questions.map((q) => q.id));
    const answered = batch.answers.filter(
      (a) => a.answer.trim() !== "" && askedIds.has(a.questionId),
    );
    if (batch.stopped && answered.length === 0) {
      return finalize("the user ended clarification");
    }
    if (answered.length === 0) {
      return finalize("the user skipped all remaining questions");
    }

    const outcome = applyAnswers(profiles, provenance, questions, answered);
    rounds.push({ round, questions, answers: answered, applied: outcome.applied });
    if (outcome.applied.length === 0) {
      return finalize("the answers given did not resolve any of the open questions");
    }
    profiles = outcome.profiles;
    provenance = outcome.provenance;

    if (batch.stopped) {
      // The user answered some questions and then said stop: apply what
      // they gave us, then finish.
      if (detectProfileGaps(profiles).length === 0) return finalize(null);
      return finalize("the user ended clarification");
    }
  }
}
