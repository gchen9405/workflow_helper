/**
 * The non-interactive clarification IO, and the minimal question shape any
 * IO accepts. Kept apart from the terminal IO (`clarification.ts`, which
 * needs readline and the console device) so the browser bundle and any
 * other Node-free host can use the same default `runPreprocessor` /
 * `runPipeline` fall back on.
 */
import type { BatchAnswers } from "../pipeline/run.js";

/**
 * The two fields a question must expose to be asked. Deliberately minimal:
 * any component whose questions carry `id` and `text` can drive an IO
 * written against this type — the recommender's richer question objects are
 * structurally assignable to it, so both clarification loops share one IO.
 */
export interface AskableQuestion {
  id: string;
  text: string;
}

/** Non-interactive mode: never ask; the pipeline finishes as partial if gaps remain. */
export const silentIO = {
  async askBatch(
    _questions: readonly AskableQuestion[],
    _round: number,
  ): Promise<BatchAnswers> {
    return { stopped: true, answers: [] };
  },
};
