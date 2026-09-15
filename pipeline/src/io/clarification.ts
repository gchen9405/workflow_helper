/**
 * Stage-aware wrapping for a stage-unaware clarification IO.
 *
 * The terminal IO exported by workflow-preprocessor prints "Clarification
 * round N" — which, in a run that has TWO clarification loops, would read
 * as round 1, 2, … and then round 1 again with no hint that the subject
 * changed from the workflow's structure to each step's attributes. This
 * wrapper announces each stage the first time it asks, and delegates
 * everything else unchanged.
 */
import type { AskableQuestion, BatchAnswers } from "workflow-preprocessor/core";
import type { ClarificationStage, PipelineClarificationIO } from "../pipeline/run.js";

/** Any IO whose `askBatch` takes (questions, round) — the preprocessor's shape. */
export interface SimpleClarificationIO {
  askBatch(questions: readonly AskableQuestion[], round: number): Promise<BatchAnswers>;
}

/** What the user is told when each stage's questions begin. */
export const STAGE_BANNERS: Record<ClarificationStage, string> = {
  preprocess:
    "About the workflow itself — filling in what the description left out. Answer in your own words.",
  recommend:
    "About each step — how often it runs, how long it takes, how sensitive its data is. Answer with the option number.",
};

/**
 * Announce each clarification stage once, then delegate to `inner`.
 * `announce` defaults to console.log, the stream the terminal IO prompts on.
 */
export function stagedIO(
  inner: SimpleClarificationIO,
  announce: (line: string) => void = (line) => console.log(line),
): PipelineClarificationIO {
  let announced: ClarificationStage | null = null;
  return {
    async askBatch(questions, round, stage) {
      if (stage !== announced) {
        announced = stage;
        announce(`\n${STAGE_BANNERS[stage]}`);
      }
      return inner.askBatch(questions, round);
    },
  };
}
