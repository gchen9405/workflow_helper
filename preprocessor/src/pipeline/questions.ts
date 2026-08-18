/**
 * Deterministic question generation: gap -> user-facing question.
 *
 * Like gap detection, this is plain code — no LLM. Each gap produces exactly
 * one question via a fixed template, questions are ordered by a fixed
 * priority (structural blockers before cosmetic fields), and each round is
 * capped so the user is never flooded.
 *
 * The question id IS the gap id, so a question in a `partial` result can be
 * traced back to the exact gap that produced it, and the same unresolved gap
 * keeps a stable id across rounds.
 */
import { gapId, type Gap } from "./gaps.js";
import type { WorkflowGraph } from "../schema/workflow.js";

export interface Question {
  /** Stable id — identical to the underlying gap's id. */
  id: string;
  /** The gap this question is trying to close. */
  gap: Gap;
  /** The text shown to the user. */
  text: string;
}

/** Default cap on questions per clarification round. */
export const DEFAULT_MAX_QUESTIONS_PER_ROUND = 8;

/**
 * Lower rank = asked earlier. Types come first because a type answer can
 * resolve suppressed start/end gaps; the workflow name never blocks anything
 * and goes last.
 */
const PRIORITY: Record<Gap["kind"], number> = {
  missing_node_type: 0,
  no_start_node: 1,
  no_end_node: 2,
  missing_node_label: 3,
  unlabeled_branch: 4,
  dead_end: 5,
  exitless_cycle: 6,
  unreachable_nodes: 7,
  missing_workflow_name: 8,
};

/** `"Check stock" (check_stock)` when labeled, `the step "check_stock"` when not. */
function describeNode(wf: WorkflowGraph, nodeId: string): string {
  const node = wf.nodes.find((n) => n.id === nodeId);
  if (node?.label) return `"${node.label}" (${node.id})`;
  return `the step "${nodeId}"`;
}

function listNodes(wf: WorkflowGraph, nodeIds: string[]): string {
  return nodeIds.map((id) => describeNode(wf, id)).join(", ");
}

function questionText(wf: WorkflowGraph, gap: Gap): string {
  switch (gap.kind) {
    case "missing_workflow_name":
      return "What should this workflow be called?";
    case "missing_node_type":
      return `Is ${describeNode(wf, gap.nodeId)} the starting point of the workflow, an end point, a task someone performs, or a decision with multiple outcomes?`;
    case "missing_node_label":
      return `The step "${gap.nodeId}" has no label. What happens in this step?`;
    case "no_start_node":
      return wf.nodes.length === 0
        ? "Where does this workflow begin? Describe the first step and what triggers it."
        : "None of the steps is marked as the starting point. Where does this workflow begin?";
    case "no_end_node":
      return wf.nodes.length === 0
        ? "How does this workflow finish? Describe the final step or outcome."
        : "None of the steps is marked as an end point. How does this workflow finish?";
    case "unlabeled_branch": {
      const targets = wf.edges
        .filter((e) => gap.edgeIds.includes(e.id))
        .map((e) => describeNode(wf, e.to))
        .join(" and ");
      return `From ${describeNode(wf, gap.nodeId)}, the workflow branches to ${targets}, but the conditions are not stated. What determines which path is taken?`;
    }
    case "dead_end":
      return `After ${describeNode(wf, gap.nodeId)}, nothing follows. What happens next — or is it actually the final step of the workflow?`;
    case "exitless_cycle":
      return `The steps ${listNodes(wf, gap.nodeIds)} form a loop that never reaches an end point. Under what condition does the loop exit, and where does the workflow go from there?`;
    case "unreachable_nodes":
      return `The step(s) ${listNodes(wf, gap.nodeIds)} are never reached from the start of the workflow. How do they connect to the rest of the flow?`;
  }
}

/**
 * Turn gaps into an ordered, capped batch of questions.
 *
 * Sorting is stable: gaps of equal priority keep the deterministic order
 * `detectGaps()` produced them in.
 */
export function buildQuestions(
  wf: WorkflowGraph,
  gaps: Gap[],
  maxQuestions: number = DEFAULT_MAX_QUESTIONS_PER_ROUND,
): Question[] {
  const ranked = gaps
    .map((gap, position) => ({ gap, position }))
    .sort(
      (a, b) =>
        PRIORITY[a.gap.kind] - PRIORITY[b.gap.kind] || a.position - b.position,
    );

  return ranked.slice(0, maxQuestions).map(({ gap }) => ({
    id: gapId(gap),
    gap,
    text: questionText(wf, gap),
  }));
}
