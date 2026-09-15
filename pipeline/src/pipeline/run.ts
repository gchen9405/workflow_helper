/**
 * The end-to-end orchestrator: one input in, the narrator's report out.
 *
 *   input ──▶ PREPROCESS ──▶ RECOMMEND ──▶ NARRATE ──▶ PipelineResult
 *   (image     (workflow      (ranked        (Markdown
 *    | text)    schema)        opportunities) report)
 *
 * Each stage keeps its own terminal-state guarantee, and the chain is
 * total — every stage accepts every terminal state of the one before it
 * (`rejected` → `unsuitable` → `notice`) — so EVERY input reaches a
 * Narration, and the pipeline's status IS the narrator's:
 *
 *   `complete` — a whole report: a model-written summary on top of the
 *                deterministic body, or the deterministic summary when none
 *                was requested;
 *   `fallback` — a whole report whose model summary was unavailable; the
 *                deterministic summary stands in and says why;
 *   `notice`   — nothing to recommend on (the input was not a workflow, or
 *                had no task/decision steps); the report says why and what
 *                to do next.
 *
 * Partial upstream states — a schema with open questions, recommendations
 * with unknown attributes — still yield `complete`: the report is whole and
 * says inside it what is uncertain. Every stage's own result is returned
 * beside the report, so a caller can read those statuses directly rather
 * than parse the report for them.
 *
 * What can still throw: transport failures (an unreachable endpoint, an
 * HTTP error after the client's own retries), a clarification channel that
 * rejects, and programming errors. Those are not terminal states — the
 * pipeline never fabricates a report it did not produce — and surface as
 * {@link PipelineStageError}, which names the stage and carries every
 * result produced before it, so a caller can show what was learned so far
 * or retry from that stage.
 *
 * The pipeline never touches stdin/stdout. User interaction happens through
 * ONE seam, {@link PipelineClarificationIO}: both clarification loops (the
 * preprocessor's free-text questions, the recommender's multiple-choice
 * ones) call it with the stage named, so a terminal, a test harness, and a
 * web session all implement the same one method. Without one, no questions
 * are asked and thin input comes back partial — still a complete report,
 * honestly hedged — which is the natural one-request-one-response shape for
 * a web backend.
 */
import {
  runPreprocessor,
  silentIO,
  type BatchAnswers,
  type ClarificationIO,
  type InputPayload,
  type LlmClient,
  type PreprocessResult,
  type Question,
} from "workflow-preprocessor/core";
import {
  runRecommender,
  type PatternDef,
  type ProfileQuestion,
  type RecommendationResult,
  type RecommenderClarificationIO,
} from "workflow-recommender";
import { narrate, type Narration } from "workflow-narrator/core";

/** The three stages, in the order they run. */
export type PipelineStage = "preprocess" | "recommend" | "narrate";

/** The two stages that may ask the user questions. */
export type ClarificationStage = "preprocess" | "recommend";

/**
 * A question from either clarification loop. Preprocessor questions are
 * answered in free text; recommender questions are multiple choice and
 * carry `options` (answer with the option's number, or its token) — see
 * {@link isChoiceQuestion}. Both have a stable `id` and the `text` to show.
 */
export type PipelineQuestion = Question | ProfileQuestion;

/** True for recommender questions, which carry the `options` to choose from. */
export function isChoiceQuestion(question: PipelineQuestion): question is ProfileQuestion {
  return "options" in question;
}

/**
 * How the pipeline talks to the user. The CLI implements this over readline;
 * a web backend implements it over its session transport; tests script it.
 *
 * `stage` says which loop is asking — the preprocessor (about the workflow's
 * structure, free text) or the recommender (about each step's attributes,
 * multiple choice) — and `round` counts within that stage. The stage-unaware
 * IOs exported by workflow-preprocessor (`ReadlineClarificationIO`,
 * `silentIO`) satisfy this interface as they are.
 */
export interface PipelineClarificationIO {
  askBatch(
    questions: readonly PipelineQuestion[],
    round: number,
    stage: ClarificationStage,
  ): Promise<BatchAnswers>;
}

/** Progress notifications: each stage's start, and its end with its status. */
export type PipelineProgress =
  | { stage: PipelineStage; phase: "start" }
  | { stage: "preprocess"; phase: "end"; status: PreprocessResult["status"] }
  | { stage: "recommend"; phase: "end"; status: RecommendationResult["status"] }
  | { stage: "narrate"; phase: "end"; status: Narration["status"] };

export interface PipelineRunOptions {
  /** The clarification channel. Default: ask nothing (thin input → partial). */
  io?: PipelineClarificationIO;
  /** Hard cap on clarification rounds, per stage. Default 10. */
  maxRounds?: number;
  /** Cap on questions per round, per stage. Default 8. */
  maxQuestionsPerRound?: number;
  /** Pattern catalog override for the recommender and the report. */
  catalog?: PatternDef[];
  /** Opportunities written up in full in the report (default 5). */
  top?: number;
  /**
   * Whether to add the model-written summary on top of the report (one LLM
   * call). `false` gives the deterministic report alone — still `complete`.
   * Default true.
   */
  summary?: boolean;
  /** How the input is referred to in the report's appendix (a file name, say). */
  inputLabel?: string;
  /** Called as each stage starts and finishes. */
  onProgress?: (progress: PipelineProgress) => void;
}

export interface PipelineResult {
  /** The narrator's terminal state — the report is the deliverable. */
  status: Narration["status"];
  /** The report, Markdown. Identical to `narration.report`. */
  report: string;
  /** The narrator's full output: report, body, summary block, source. */
  narration: Narration;
  /** The preprocessor's result: the schema, open questions, Q&A rounds. */
  preprocess: PreprocessResult;
  /** The recommender's result: profiles, motifs, ranked opportunities. */
  recommendation: RecommendationResult;
}

export const DEFAULT_INPUT_LABEL = "input";

/**
 * A stage threw instead of reaching a terminal state. `cause` is the
 * original error (an `LlmHttpError`, a network error, whatever the
 * clarification channel rejected with); `preprocess` / `recommendation`
 * hold the results of the stages that had already finished.
 */
export class PipelineStageError extends Error {
  readonly stage: PipelineStage;
  readonly preprocess: PreprocessResult | null;
  readonly recommendation: RecommendationResult | null;

  constructor(
    stage: PipelineStage,
    cause: unknown,
    produced: { preprocess?: PreprocessResult; recommendation?: RecommendationResult } = {},
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`the ${stage} stage failed: ${detail}`, { cause });
    this.name = "PipelineStageError";
    this.stage = stage;
    this.preprocess = produced.preprocess ?? null;
    this.recommendation = produced.recommendation ?? null;
  }
}

export async function runPipeline(
  llm: LlmClient,
  input: InputPayload,
  options: PipelineRunOptions = {},
): Promise<PipelineResult> {
  const io = options.io ?? silentIO;
  const progress = options.onProgress ?? (() => {});
  const loop = {
    maxRounds: options.maxRounds,
    maxQuestionsPerRound: options.maxQuestionsPerRound,
  };

  // ---- Stage 1: preprocess — input → workflow schema ------------------------
  const preprocessIO: ClarificationIO = {
    askBatch: (questions, round) => io.askBatch(questions, round, "preprocess"),
  };
  progress({ stage: "preprocess", phase: "start" });
  let preprocess: PreprocessResult;
  try {
    preprocess = await runPreprocessor(llm, input, preprocessIO, loop);
  } catch (err) {
    throw new PipelineStageError("preprocess", err);
  }
  progress({ stage: "preprocess", phase: "end", status: preprocess.status });

  // ---- Stage 2: recommend — schema → ranked opportunities ------------------
  // The recommender takes the preprocessor result whole, including
  // `rejected` (→ `unsuitable`, no LLM call) and `partial` (its open
  // questions are inherited and lower the affected confidences).
  const recommendIO: RecommenderClarificationIO = {
    askBatch: (questions, round) => io.askBatch(questions, round, "recommend"),
  };
  progress({ stage: "recommend", phase: "start" });
  let recommendation: RecommendationResult;
  try {
    recommendation = await runRecommender(llm, preprocess, recommendIO, {
      ...loop,
      catalog: options.catalog,
    });
  } catch (err) {
    throw new PipelineStageError("recommend", err, { preprocess });
  }
  progress({ stage: "recommend", phase: "end", status: recommendation.status });

  // ---- Stage 3: narrate — opportunities → report ---------------------------
  // The schema is handed over directly for step names, flow order, and
  // branch labels; nothing is looked up on disk.
  progress({ stage: "narrate", phase: "start" });
  let narration: Narration;
  try {
    narration = await narrate(options.summary === false ? null : llm, recommendation, {
      workflow: preprocess.status === "rejected" ? null : preprocess.schema,
      catalog: options.catalog,
      top: options.top,
      inputLabel: options.inputLabel ?? DEFAULT_INPUT_LABEL,
    });
  } catch (err) {
    throw new PipelineStageError("narrate", err, { preprocess, recommendation });
  }
  progress({ stage: "narrate", phase: "end", status: narration.status });

  return {
    status: narration.status,
    report: narration.report,
    narration,
    preprocess,
    recommendation,
  };
}
