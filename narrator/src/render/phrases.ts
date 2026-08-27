/**
 * The vocabulary → prose layer. Every enum token the recommender emits has a
 * fixed English rendering here, so the deterministic body reads as sentences
 * rather than snake_case — and so a token added to a vocabulary upstream is a
 * TYPE ERROR here (`Record<Enum, string>`), never a silent "undefined" in a
 * report.
 */
import type {
  ActorKind,
  AutomationClass,
  Confidence,
  Deployment,
  Duration,
  Effort,
  ErrorProneness,
  Frequency,
  Judgment,
  MotifKind,
  RecommenderProvenance,
  Sensitivity,
  Structure,
} from "workflow-recommender";

export const FREQUENCY_PHRASE: Record<Frequency, string> = {
  ad_hoc: "runs ad hoc",
  monthly: "runs monthly",
  weekly: "runs weekly",
  daily: "runs daily",
  many_per_day: "runs many times a day",
};

export const DURATION_PHRASE: Record<Duration, string> = {
  under_5_min: "takes under 5 minutes per run",
  "5_to_30_min": "takes 5–30 minutes per run",
  "30_min_to_2_h": "takes 30 minutes – 2 hours per run",
  "2_h_to_1_day": "takes 2 hours – 1 day per run",
  multi_day: "takes multiple days per run",
};

export const STRUCTURE_PHRASE: Record<Structure, string> = {
  case_by_case: "is handled case by case",
  guidelines_with_exceptions: "follows guidelines with exceptions",
  mostly_rules: "follows mostly fixed rules",
  fully_rule_based: "is fully rule-based",
};

export const JUDGMENT_PHRASE: Record<Judgment, string> = {
  expert: "needs expert judgment",
  experienced: "needs experienced judgment",
  routine: "needs only routine judgment",
  none: "needs no human judgment",
};

export const SENSITIVITY_PHRASE: Record<Sensitivity, string> = {
  public: "touches public data",
  internal: "touches internal data",
  confidential: "touches confidential data",
  regulated: "touches regulated data",
};

export const ACTOR_PHRASE: Record<ActorKind, string> = {
  human: "done by a person",
  system: "done by a system",
  ai_agent: "done by an AI agent",
  mixed: "done by people and systems together",
};

export const ERROR_PHRASE: Record<ErrorProneness, string> = {
  rare: "rarely goes wrong",
  occasional: "occasionally goes wrong",
  frequent: "frequently goes wrong",
};

export const MOTIF_PHRASE: Record<MotifKind, string> = {
  manual_data_transfer_chain: "manual data-transfer chain",
  approval_chain: "approval chain",
  notification_tail: "notification tail",
  repeated_similar_tasks: "repeated similar tasks",
  long_manual_chain: "long manual chain",
  rework_loop: "rework loop",
};

/** What each motif means, for readers who have not seen the vocabulary. */
export const MOTIF_GLOSS: Record<MotifKind, string> = {
  manual_data_transfer_chain: "people re-keying data between systems across connected steps",
  approval_chain: "back-to-back approvals with nothing in between",
  notification_tail: "a notification after which the flow only notifies, files, or ends",
  repeated_similar_tasks: "the same kind of step, by the same actor, appearing more than once",
  long_manual_chain: "an unbroken run of manual steps by the same actor",
  rework_loop: "a cycle that keeps sending work back through a review or verification step",
};

export const DEPLOYMENT_PHRASE: Record<Deployment, string> = {
  external_saas: "an external SaaS service",
  internal_endpoint: "the company's internal LLM endpoint",
  on_prem: "on-premises infrastructure",
  non_ai: "no AI involved",
};

export const AUTOMATION_CLASS_PHRASE: Record<AutomationClass, string> = {
  eliminate: "non-AI change (eliminate)",
  consolidate: "non-AI change (consolidate)",
  batch: "non-AI change (batch)",
  standardize: "non-AI change (standardize)",
  rule_based_automation: "non-AI change (rule-based automation)",
  rpa: "non-AI change (RPA)",
  delegate: "non-AI change (delegate)",
  ai_assist: "AI assists, a person stays in the loop",
  ai_automate: "AI automation",
};

export function isAiClass(cls: AutomationClass): boolean {
  return cls === "ai_assist" || cls === "ai_automate";
}

export const EFFORT_PHRASE: Record<Effort, string> = {
  low: "low effort",
  medium: "medium effort",
  high: "high effort",
};

export const CONFIDENCE_PHRASE: Record<Confidence, string> = {
  high: "high confidence",
  medium: "medium confidence",
  low: "low confidence",
};

/**
 * Provenance markers used wherever a value is quoted: unmarked = stated in
 * the input, `*` = inferred by the model from the wording, `†` = confirmed
 * by the user in clarification. The legend is printed once per report.
 */
export const PROVENANCE_MARK: Record<RecommenderProvenance, string> = {
  original: "",
  inferred: "*",
  user_elicited: "†",
};

export const PROVENANCE_LEGEND =
  "Values marked * were inferred by the model from the wording rather than stated in the input; " +
  "values marked † were confirmed by the user during clarification; unmarked values were stated in the input.";

export const quote = (label: string): string => `"${label}"`;

/**
 * Lowercase the first letter, for splicing a sentence into a clause —
 * except when the word is an acronym or initialism ("RSS/arXiv alerts",
 * "AI review …"), which a blind downcase would mangle.
 */
export function lowerFirst(text: string): string {
  if (text.length === 0) return text;
  if (/^[A-Z][A-Z]/.test(text)) return text;
  return text[0].toLowerCase() + text.slice(1);
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Join with commas and a final "and". */
export function listPhrase(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Escape a cell for a Markdown table. */
export function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// ---------------------------------------------------------------------------
// The plain-language layer
//
// Everything above renders a value FAITHFULLY; everything below renders it
// BRIEFLY, for the decision layer of the report (the "Where to start" table,
// the recommendation headers, the trimmed step list). Both are deterministic
// and both are printed — the short form leads, the faithful form remains in
// the appendix — so shortening never costs the reader a fact.
// ---------------------------------------------------------------------------

/** Frequency without the "runs" verb, for lists and table cells. */
export const FREQUENCY_SHORT: Record<Frequency, string> = {
  ad_hoc: "ad hoc",
  monthly: "monthly",
  weekly: "weekly",
  daily: "daily",
  many_per_day: "many times a day",
};

/** Duration without the "takes … per run" frame. */
export const DURATION_SHORT: Record<Duration, string> = {
  under_5_min: "under 5 minutes each time",
  "5_to_30_min": "5–30 minutes each time",
  "30_min_to_2_h": "30 minutes – 2 hours each time",
  "2_h_to_1_day": "2 hours – 1 day each time",
  multi_day: "several days each time",
};

/**
 * What a change actually involves, in the reader's terms, rather than by the
 * catalog's class name. The AI/non-AI split is the first thing a workflow
 * owner wants to know, so it leads every phrase.
 */
export const AUTOMATION_CLASS_SHORT: Record<AutomationClass, string> = {
  eliminate: "no AI — drop the step",
  consolidate: "no AI — merge steps",
  batch: "no AI — do it in batches",
  standardize: "no AI — fix the inputs",
  rule_based_automation: "no AI — a script does it",
  rpa: "no AI — software drives the tools",
  delegate: "no AI — someone else does it",
  ai_assist: "AI helps, a person still decides",
  ai_automate: "AI does it end to end",
};

/** Effort as a one-word table cell. */
export const EFFORT_WORD: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Confidence as a one-word table cell. */
export const CONFIDENCE_WORD: Record<Confidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * What a confidence level means, without the vocabulary — short enough to
 * sit in a recommendation's one-line header. What earned it is spelled out
 * in that recommendation's own collapsed block; what the levels mean in
 * general is in the appendix.
 */
export const CONFIDENCE_PLAIN: Record<Confidence, string> = {
  high: "confident",
  medium: "reasonably confident",
  low: "tentative — key facts are missing",
};

/**
 * Plain-language bands over the 0–100 score.
 *
 * The score is objective; the band is a FIXED, DOCUMENTED reading of it —
 * the thresholds are constants, the same for every report, and printed in
 * the appendix so a reader can always recover the raw number's meaning. The
 * band never replaces the score: the two are always printed together.
 *
 * Ordered high → low; `scoreBand` takes the first band the score reaches.
 */
export const SCORE_BANDS: ReadonlyArray<{ min: number; label: string }> = [
  { min: 35, label: "Strong candidate" },
  { min: 20, label: "Promising" },
  { min: 10, label: "Worth a look" },
  { min: 0, label: "Low priority" },
];

export function scoreBand(total: number): string {
  return (SCORE_BANDS.find((b) => total >= b.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1]).label;
}

/** The band and the raw score together — the only way either is printed. */
export function scoreLabel(total: number): string {
  return `${scoreBand(total)} (${total}/100)`;
}

/** The legend that lets a reader re-derive any band from its score. */
export const SCORE_BAND_LEGEND = SCORE_BANDS.map((band, i) => {
  const above = SCORE_BANDS[i - 1];
  const range = above ? `${band.min}–${above.min - 1}` : `${band.min} and above`;
  return `${range} “${band.label}”`;
}).join(" · ");

/** Where a deployment option runs, as a prose clause rather than a label. */
export const DEPLOYMENT_SHORT: Record<Deployment, string> = {
  external_saas: "hosted by an outside vendor",
  internal_endpoint: "on the company's own LLM service",
  on_prem: "on hardware you control",
  non_ai: "with no AI involved",
};
