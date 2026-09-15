/**
 * The orchestrator. Owns the single state object, wires the stages together,
 * and enforces the terminal-state guarantee:
 *
 *   EVERY input terminates in exactly one of three states —
 *     1. `validated` — a complete schema (zero gaps);
 *     2. `partial`   — a schema with explicitly listed open questions;
 *     3. `rejected`  — a graceful rejection with a stated reason.
 *   Never a confident-looking schema from garbage input.
 *
 * How each exit is reached:
 *
 *   rejected:
 *     - triage says the input is not a workflow (reason from triage);
 *     - a pre-schema stage (triage/normalize/extract) hits a safety refusal
 *       or exhausts the internal repair loop — we refuse to fabricate a
 *       schema we could not derive.
 *   validated:
 *     - `detectGaps()` (deterministic, unit-tested code) returns empty.
 *   partial:
 *     - the user stops or skips all remaining questions;
 *     - the round cap is reached;
 *     - a clarification round yields zero applicable information;
 *     - the answer-application call fails after the schema already exists
 *       (the schema so far is still returned, with its open questions).
 *
 * Termination argument: the loop can only continue when a round applied at
 * least one patch AND the round counter is below the cap. The round cap makes
 * the loop finite regardless of what the LLM or the user does.
 */
import {
  LlmRefusalError,
  LlmRepairExhaustedError,
  type LlmClient,
} from "../llm/client.js";
import type { InputPayload } from "../io/payload.js";
import { stampOriginalProvenance, type Workflow } from "../schema/workflow.js";
import type { Patch } from "../schema/patches.js";
import { detectGaps, type Gap } from "./gaps.js";
import {
  buildQuestions,
  DEFAULT_MAX_QUESTIONS_PER_ROUND,
  type Question,
} from "./questions.js";
import { applyAnswersWithLlm, type AnsweredQuestion } from "./clarify.js";
import {
  extractDraft,
  normalizeToIntermediate,
  triageInput,
  type TriageResult,
} from "./stages.js";

/** One completed clarification round, kept for auditability. */
export interface QARound {
  round: number;
  questions: Question[];
  answers: { questionId: string; answer: string }[];
  patches: Patch[];
}

/**
 * The single object that holds all pipeline state. Every LLM call is a
 * stateless function over (a slice of) this object; nothing else carries
 * state between stages.
 */
export interface PreprocessorState {
  input: InputPayload;
  triage: TriageResult | null;
  /** The graph-shaped text intermediate (null until normalization ran). */
  intermediate: string | null;
  workflow: Workflow | null;
  /** Gaps from the most recent detection pass. */
  gaps: Gap[];
  rounds: QARound[];
}

export type PreprocessResult =
  | {
      status: "validated";
      schema: Workflow;
      intermediate: string | null;
      rounds: QARound[];
    }
  | {
      status: "partial";
      schema: Workflow;
      /** Every question still open, uncapped, traceable to its gap. */
      openQuestions: Question[];
      reason: string;
      intermediate: string | null;
      rounds: QARound[];
    }
  | { status: "rejected"; reason: string };

/** The answers a UI collected for one batch of questions. */
export interface BatchAnswers {
  /** True when the user explicitly ended clarification ("stop"). */
  stopped: boolean;
  /** One entry per question the user responded to; empty answer = skipped. */
  answers: { questionId: string; answer: string }[];
}

/**
 * How the pipeline talks to the user. The CLI implements this over readline;
 * a web UI or a test harness implements it differently. The pipeline itself
 * never touches stdin/stdout.
 */
export interface ClarificationIO {
  askBatch(questions: Question[], round: number): Promise<BatchAnswers>;
}

export interface RunOptions {
  /** Hard cap on clarification rounds. Guarantees termination. Default 10. */
  maxRounds?: number;
  /** Cap on questions per round. Default 8. */
  maxQuestionsPerRound?: number;
}

export const DEFAULT_MAX_ROUNDS = 10;

function isLlmFailure(err: unknown): err is LlmRefusalError | LlmRepairExhaustedError {
  return err instanceof LlmRefusalError || err instanceof LlmRepairExhaustedError;
}

export async function runPreprocessor(
  llm: LlmClient,
  input: InputPayload,
  io: ClarificationIO,
  options: RunOptions = {},
): Promise<PreprocessResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxQuestionsPerRound =
    options.maxQuestionsPerRound ?? DEFAULT_MAX_QUESTIONS_PER_ROUND;

  const state: PreprocessorState = {
    input,
    triage: null,
    intermediate: null,
    workflow: null,
    gaps: [],
    rounds: [],
  };

  // ---- Stage 1: triage (reject non-workflows gracefully) -------------------
  try {
    state.triage = await triageInput(llm, state.input);
  } catch (err) {
    if (isLlmFailure(err)) return { status: "rejected", reason: err.message };
    throw err;
  }
  if (!state.triage.isWorkflow) {
    return {
      status: "rejected",
      reason: `the input does not appear to be a workflow: ${state.triage.reason}`,
    };
  }

  // ---- Stages 2 + 3: normalize to the intermediate, then extract -----------
  try {
    state.intermediate = await normalizeToIntermediate(llm, state.input);
    const draft = await extractDraft(llm, state.intermediate);
    state.workflow = stampOriginalProvenance(draft);
  } catch (err) {
    // No schema exists yet, so failure here is a graceful rejection — we
    // never fabricate a schema we could not actually derive.
    if (isLlmFailure(err)) {
      return {
        status: "rejected",
        reason: `could not derive a structurally valid workflow from the input (${err.message})`,
      };
    }
    throw err;
  }

  // ---- Clarification loop: gaps are the termination condition --------------
  const partial = (reason: string): PreprocessResult => ({
    status: "partial",
    schema: state.workflow!,
    openQuestions: buildQuestions(
      state.workflow!,
      detectGaps(state.workflow!),
      Number.POSITIVE_INFINITY,
    ),
    reason,
    intermediate: state.intermediate,
    rounds: state.rounds,
  });

  for (let round = 1; ; round++) {
    state.gaps = detectGaps(state.workflow);
    if (state.gaps.length === 0) {
      return {
        status: "validated",
        schema: state.workflow,
        intermediate: state.intermediate,
        rounds: state.rounds,
      };
    }
    if (round > maxRounds) {
      return partial(
        `the clarification round limit (${maxRounds}) was reached with questions still open`,
      );
    }

    const questions = buildQuestions(state.workflow, state.gaps, maxQuestionsPerRound);
    const batch = await io.askBatch(questions, round);

    const questionById = new Map(questions.map((q) => [q.id, q]));
    const answered: AnsweredQuestion[] = batch.answers
      .filter((a) => a.answer.trim() !== "" && questionById.has(a.questionId))
      .map((a) => ({ question: questionById.get(a.questionId)!, answer: a.answer.trim() }));

    if (batch.stopped && answered.length === 0) {
      return partial("the user ended clarification");
    }
    if (answered.length === 0) {
      return partial("the user skipped all remaining questions");
    }

    try {
      const outcome = await applyAnswersWithLlm(llm, state.workflow, answered);
      state.rounds.push({
        round,
        questions,
        answers: answered.map((a) => ({
          questionId: a.question.id,
          answer: a.answer,
        })),
        patches: outcome.patches,
      });
      if (outcome.appliedCount === 0) {
        return partial(
          "the answers given did not resolve any of the open questions",
        );
      }
      state.workflow = outcome.workflow;
    } catch (err) {
      // A schema exists — return it as partial rather than throwing it away.
      if (isLlmFailure(err)) {
        return partial(`could not interpret the answers (${err.message})`);
      }
      throw err;
    }

    if (batch.stopped) {
      // The user answered some questions and then said stop: apply what they
      // gave us, then finish.
      state.gaps = detectGaps(state.workflow);
      if (state.gaps.length === 0) {
        return {
          status: "validated",
          schema: state.workflow,
          intermediate: state.intermediate,
          rounds: state.rounds,
        };
      }
      return partial("the user ended clarification");
    }
  }
}
