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
