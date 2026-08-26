/**
 * Deterministic answer application — the recommender's half of the
 * clarification loop, with NO LLM anywhere: every question offers a closed
 * set of options, so parsing an answer is plain code. (The preprocessor
 * needs an LLM here because its answers are free text; ours are picks.)
 *
 * An answer is accepted as:
 *   - the option number ("3", "3)", "3.");
 *   - the enum token, case-insensitive, spaces/hyphens for underscores
 *     ("mostly rules" → mostly_rules);
 *   - the display wording the question showed ("many times a day");
 *   - an unambiguous prefix of either ("reg" → regulated).
 * Anything else does not apply, the gap persists, and it is re-asked (or the
 * run ends `partial` when a whole round applied nothing — see run.ts).
 *
 * Application is pure: it returns NEW profiles and provenance. Applied
 * answers set the value, stamp `user_elicited` provenance, and CLEAR
 * basis/evidence — the `value ⇔ basis` invariant binds LLM drafts only, and
 * a stale "inferred from …" note under a user-stated value would lie.
 *
 * The workflow-level sensitivity answer fills dataSensitivity on every node
 * where it is still null AT APPLY TIME (per-node inferences and earlier
 * answers are kept).
 */
import {
  profilePath,
  type NodeProfile,
  type RecommenderProvenance,
  type RequiredAttribute,
} from "../schema/profile.js";
import type { Sensitivity } from "../schema/taxonomy.js";
import type { ProfileQuestion } from "./questions.js";

/** One assignment parsed out of an answer, kept for auditability. */
export interface AppliedAnswer {
  questionId: string;
  /** The nodes the assignment touched (several for the workflow-level question). */
  nodeIds: string[];
  field: "taskClass" | RequiredAttribute;
  value: string;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Resolve one answer against the question's options. Returns the matched
 * enum token, or null when the answer does not resolve unambiguously.
 */
export function parseChoice(answer: string, options: readonly string[]): string | null {
  const trimmed = answer.trim();
  if (trimmed === "") return null;

  const numberMatch = /^(\d+)[).]?$/.exec(trimmed);
  if (numberMatch) {
    const index = Number(numberMatch[1]) - 1;
    return index >= 0 && index < options.length ? options[index] : null;
  }

  const norm = normalize(trimmed);
  // Keys a token answers to: the token itself, and (loosely) its display
  // wording. Display strings live in questions.ts; matching the token with
  // separators normalized covers the common phrasings without importing them.
  const exact = options.filter((token) => normalize(token) === norm);
  if (exact.length === 1) return exact[0];

  const prefixed = options.filter((token) => normalize(token).startsWith(norm));
  if (prefixed.length === 1) return prefixed[0];

  return null;
}

export interface ApplyAnswersResult {
  profiles: NodeProfile[];
  provenance: Record<string, RecommenderProvenance>;
  applied: AppliedAnswer[];
}

export function applyAnswers(
  profiles: NodeProfile[],
  provenance: Record<string, RecommenderProvenance>,
  questions: ProfileQuestion[],
  answers: { questionId: string; answer: string }[],
): ApplyAnswersResult {
  const next = structuredClone(profiles);
  const nextProvenance = { ...provenance };
  const applied: AppliedAnswer[] = [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const profileById = new Map(next.map((p) => [p.nodeId, p]));

  for (const { questionId, answer } of answers) {
    const question = byId.get(questionId);
    if (!question) continue;
    const value = parseChoice(answer, question.options);
    if (value === null) continue;

    const subject = question.subject;
    if (subject.kind === "workflow_data_sensitivity") {
      const filled: string[] = [];
      for (const profile of next) {
        if (profile.attributes.dataSensitivity.value === null) {
          profile.attributes.dataSensitivity = {
            value: value as Sensitivity,
            basis: null,
            evidence: null,
          };
          nextProvenance[profilePath.attr(profile.nodeId, "dataSensitivity")] =
            "user_elicited";
          filled.push(profile.nodeId);
        }
      }
      if (filled.length > 0) {
        applied.push({ questionId, nodeIds: filled, field: "dataSensitivity", value });
      }
      continue;
    }

    const profile = profileById.get(subject.nodeId);
    if (!profile) continue;

    if (subject.kind === "missing_task_class") {
      profile.taskClass = {
        value: value as NodeProfile["taskClass"]["value"],
        basis: null,
        evidence: null,
      };
      nextProvenance[profilePath.taskClass(subject.nodeId)] = "user_elicited";
      applied.push({ questionId, nodeIds: [subject.nodeId], field: "taskClass", value });
    } else {
      const attribute = subject.attribute;
      profile.attributes[attribute] = {
        value: value as never,
        basis: null,
        evidence: null,
      };
      nextProvenance[profilePath.attr(subject.nodeId, attribute)] = "user_elicited";
      applied.push({ questionId, nodeIds: [subject.nodeId], field: attribute, value });
    }
  }

  return { profiles: next, provenance: nextProvenance, applied };
}
