/**
 * The narrator's output — a report plus the terminal-state guarantee the
 * sibling components make:
 *
 *   EVERY input terminates in exactly one of three states —
 *     1. `complete` — the report is whole: a model-written summary on top of
 *                     the deterministic body when a model was available, or
 *                     the deterministic summary when none was requested;
 *     2. `fallback` — a model WAS given but its summary was unavailable
 *                     (declined, repeatedly ungrounded, endpoint error); the
 *                     report still carries the full deterministic body with
 *                     the deterministic summary, and `summary.reason` says
 *                     why;
 *     3. `notice`   — the recommender result was `unsuitable`, so there is
 *                     nothing to summarize; the report explains the reason
 *                     and what to do next.
 *
 * The deterministic body is never lost: the model layer can only ADD a
 * summary, never replace or block the text every figure is traceable to.
 */

/** The five slots every summary fills — model-written or deterministic. */
export interface SummaryContent {
  /** One sentence stating the main conclusion. */
  headline: string;
  /** Short plain-prose paragraphs (blank-line separated). */
  overview: string;
  /** Single-sentence takeaways, most important first. */
  takeaways: string[];
  /** The one concrete action to start with. */
  firstStep: string;
  /** Confidence limits, open questions, exclusions. May be empty. */
  caveats: string[];
}

export type SummaryBlock =
  | ({ kind: "model" } & SummaryContent)
  | ({ kind: "deterministic"; reason: string } & SummaryContent);

export interface NarrationSource {
  /** How the input was referred to (its file name, or a caller-given label). */
  inputLabel: string;
  recommenderStatus: "recommended" | "partial" | "unsuitable";
  workflowName: string | null;
  /** The preprocessor result the step names came from, when one was found. */
  workflowPath: string | null;
}

export interface Narration {
  status: "complete" | "fallback" | "notice";
  /** The whole report, Markdown. */
  report: string;
  /** The deterministic sections only — exactly what the model was shown. */
  body: string;
  /** Null for `notice` (nothing to summarize). */
  summary: SummaryBlock | null;
  source: NarrationSource;
}
