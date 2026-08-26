/**
 * Deterministic question generation: attribute gap -> numbered
 * multiple-choice question. No LLM — and, unlike the preprocessor, none is
 * needed on the way back either: every answer is a pick from a closed scale,
 * so `answers.ts` parses it with plain code.
 *
 * Conventions carried over from the preprocessor:
 * - question id IS the gap id (stable across rounds);
 * - fixed priority order, stable sort, capped per round.
 *
 * Priority puts `dataSensitivity` first (it HARD-FILTERS variants, so its
 * answer changes recommendations the most), then `taskClass` (it decides
 * which patterns can match at all), then `actorKind` (motifs and AI-pattern
 * gating), then the impact scales, then the feasibility scales.
 *
 * THE WORKFLOW-LEVEL SENSITIVITY QUESTION: data sensitivity is usually
 * uniform across one workflow, so when two or more nodes are missing it —
 * and the workflow-level question has not been asked yet — those per-node
 * gaps collapse into ONE question whose answer fills every node still
 * unknown. If the user skips it, the next round falls back to per-node
 * questions (the caller records that it was asked). This keeps the worst
 * case of N nodes × 6 attributes from burying the user.
 */
import type { WorkflowGraph } from "workflow-preprocessor";
import {
  ACTOR_KINDS,
  DURATIONS,
  FREQUENCIES,
  JUDGMENTS,
  SENSITIVITIES,
  STRUCTURES,
  TASK_CLASSES,
} from "../schema/taxonomy.js";
import type { RequiredAttribute } from "../schema/profile.js";
import { profileGapId, type ProfileGap } from "./gaps.js";

/** The id of the one workflow-level question. */
export const WORKFLOW_SENSITIVITY_QUESTION_ID = "workflow_data_sensitivity";

/** What a question is about: one per-node gap, or the workflow-level collapse. */
export type QuestionSubject =
  | ProfileGap
  | { kind: "workflow_data_sensitivity"; nodeIds: string[] };

export interface ProfileQuestion {
  /** Stable id — the gap id, or WORKFLOW_SENSITIVITY_QUESTION_ID. */
  id: string;
  subject: QuestionSubject;
  /** Shown to the user; includes the numbered options. */
  text: string;
  /** The enum tokens the numbered options map to, in display order. */
  options: readonly string[];
}

/** Default cap on questions per clarification round (preprocessor parity). */
export const DEFAULT_MAX_QUESTIONS_PER_ROUND = 8;

const PRIORITY: Record<RequiredAttribute | "taskClass" | "workflow", number> = {
  workflow: 0,
  dataSensitivity: 0,
  taskClass: 1,
  actorKind: 2,
  frequency: 3,
  duration: 4,
  structure: 5,
  judgment: 6,
};

/** Display strings for enum tokens where the raw token reads poorly. */
const DISPLAY: Record<string, string> = {
  ad_hoc: "ad hoc",
  many_per_day: "many times a day",
  under_5_min: "under 5 minutes",
  "5_to_30_min": "5–30 minutes",
  "30_min_to_2_h": "30 minutes – 2 hours",
  "2_h_to_1_day": "2 hours – 1 day",
  multi_day: "multiple days",
  case_by_case: "handled case by case",
  guidelines_with_exceptions: "guidelines with exceptions",
  mostly_rules: "mostly fixed rules",
  fully_rule_based: "fully rule-based",
  expert: "deep expert judgment",
  experienced: "experienced judgment",
  routine: "routine judgment",
  none: "no real judgment",
  regulated: "regulated (e.g. PII, health, financial)",
  human: "a person",
  system: "a software system",
  ai_agent: "an AI agent",
  mixed: "a mix",
};

/** Human wording for an enum token (also used by score.ts explanations). */
export function displayToken(token: string): string {
  return DISPLAY[token] ?? token.replace(/_/g, " ");
}

function renderOptions(options: readonly string[]): string {
  return options.map((token, i) => `${i + 1}) ${displayToken(token)}`).join("  ");
}

/** The enum tokens a subject's answer must come from. */
export function questionOptions(subject: QuestionSubject): readonly string[] {
  if (subject.kind === "missing_task_class") return TASK_CLASSES;
  if (subject.kind === "workflow_data_sensitivity") return SENSITIVITIES;
  switch (subject.attribute) {
    case "frequency":
      return FREQUENCIES;
    case "duration":
      return DURATIONS;
    case "structure":
      return STRUCTURES;
    case "judgment":
      return JUDGMENTS;
    case "dataSensitivity":
      return SENSITIVITIES;
    case "actorKind":
      return ACTOR_KINDS;
  }
}

/** `"Check stock" (check_stock)` when labeled, `the step "check_stock"` when not. */
function describeNode(wf: WorkflowGraph, nodeId: string): string {
  const node = wf.nodes.find((n) => n.id === nodeId);
  if (node?.label) return `"${node.label}" (${node.id})`;
  return `the step "${nodeId}"`;
}

function questionText(wf: WorkflowGraph, subject: QuestionSubject): string {
  const options = renderOptions(questionOptions(subject));
  if (subject.kind === "workflow_data_sensitivity") {
    return (
      "Overall, how sensitive is the data flowing through this workflow? " +
      "(applies to every step not answered individually)\n   " +
      options
    );
  }
  if (subject.kind === "missing_task_class") {
    return `What kind of work is ${describeNode(wf, subject.nodeId)}?\n   ${options}`;
  }
  const node = describeNode(wf, subject.nodeId);
  const stem = {
    frequency: `How often is ${node} performed?`,
    duration: `How long does one run of ${node} typically take?`,
    structure: `Could the way ${node} is done be written down as explicit rules?`,
    judgment: `How much human judgment does ${node} require?`,
    dataSensitivity: `How sensitive is the data ${node} touches?`,
    actorKind: `Who performs ${node} today?`,
  }[subject.attribute];
  return `${stem}\n   ${options}`;
}

export interface BuildQuestionOptions {
  /**
   * True once the workflow-level sensitivity question has been asked (and
   * skipped) — per-node sensitivity questions are used from then on. Also
   * set when building the final uncapped `openQuestions` list, which must
   * be complete per node.
   */
  workflowSensitivityAsked: boolean;
}

/**
 * Turn gaps into an ordered, capped batch of questions, collapsing per-node
 * sensitivity gaps into the workflow-level question when applicable.
 * Sorting is stable: subjects of equal priority keep detection order.
 */
export function buildProfileQuestions(
  wf: WorkflowGraph,
  gaps: ProfileGap[],
  maxQuestions: number = DEFAULT_MAX_QUESTIONS_PER_ROUND,
  options: BuildQuestionOptions = { workflowSensitivityAsked: false },
): ProfileQuestion[] {
  const sensitivityGaps = gaps.filter(
    (g) => g.kind === "missing_attribute" && g.attribute === "dataSensitivity",
  );
  const collapse = !options.workflowSensitivityAsked && sensitivityGaps.length >= 2;

  const subjects: QuestionSubject[] = [];
  if (collapse) {
    subjects.push({
      kind: "workflow_data_sensitivity",
      nodeIds: sensitivityGaps.map((g) => g.nodeId),
    });
  }
  for (const gap of gaps) {
    if (collapse && gap.kind === "missing_attribute" && gap.attribute === "dataSensitivity") {
      continue;
    }
    subjects.push(gap);
  }

  const priorityOf = (subject: QuestionSubject): number => {
    if (subject.kind === "workflow_data_sensitivity") return PRIORITY.workflow;
    if (subject.kind === "missing_task_class") return PRIORITY.taskClass;
    return PRIORITY[subject.attribute];
  };

  return subjects
    .map((subject, position) => ({ subject, position }))
    .sort((a, b) => priorityOf(a.subject) - priorityOf(b.subject) || a.position - b.position)
    .slice(0, maxQuestions)
    .map(({ subject }) => ({
      id:
        subject.kind === "workflow_data_sensitivity"
          ? WORKFLOW_SENSITIVITY_QUESTION_ID
          : profileGapId(subject),
      subject,
      text: questionText(wf, subject),
      options: questionOptions(subject),
    }));
}
