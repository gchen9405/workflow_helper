/**
 * Deterministic attribute-gap detection — the clarification loop's
 * termination condition, mirroring the preprocessor's `detectGaps` contract:
 * plain unit-tested code, no LLM, and `detectProfileGaps() === []` IS the
 * definition of a fully profiled workflow.
 *
 * The detectors and their firing rules:
 *
 * | Gap                 | Fires when                                          |
 * |---------------------|-----------------------------------------------------|
 * | missing_task_class  | a profile's taskClass value is null                 |
 * | missing_attribute   | a REQUIRED attribute's value is null                |
 *
 * Required attributes are `frequency, duration, structure, judgment,
 * dataSensitivity, actorKind` (`REQUIRED_ATTRIBUTES`). `errorProneness` is
 * optional enrichment and never a gap — the same reasoning as the
 * preprocessor's `description`/`actor`: otherwise every workflow generates
 * unbounded questions.
 *
 * Unlike the preprocessor, open gaps here never block the result:
 * recommendations are still produced with conservative substitutions
 * (see `match.ts`). Gaps only decide whether the terminal state is
 * `recommended` or `partial`, and what `openQuestions` lists.
 */
import {
  REQUIRED_ATTRIBUTES,
  type NodeProfile,
  type RequiredAttribute,
} from "../schema/profile.js";

export type ProfileGap =
  | { kind: "missing_task_class"; nodeId: string }
  | { kind: "missing_attribute"; nodeId: string; attribute: RequiredAttribute };

/**
 * Stable identifier for a gap; doubles as the question id so the same
 * unresolved gap keeps its id across rounds (the preprocessor's `gapId`
 * convention).
 */
export function profileGapId(gap: ProfileGap): string {
  return gap.kind === "missing_task_class"
    ? `${gap.kind}:${gap.nodeId}`
    : `${gap.kind}:${gap.nodeId}:${gap.attribute}`;
}

/**
 * Run the detectors over every profile, in profile order — class first,
 * then attributes in their declared order. Deterministic.
 */
export function detectProfileGaps(profiles: NodeProfile[]): ProfileGap[] {
  const gaps: ProfileGap[] = [];
  for (const profile of profiles) {
    if (profile.taskClass.value === null) {
      gaps.push({ kind: "missing_task_class", nodeId: profile.nodeId });
    }
    for (const attribute of REQUIRED_ATTRIBUTES) {
      if (profile.attributes[attribute].value === null) {
        gaps.push({ kind: "missing_attribute", nodeId: profile.nodeId, attribute });
      }
    }
  }
  return gaps;
}
