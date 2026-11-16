/**
 * Deterministic gap descriptions: gap -> plain-language statement of what is
 * still unknown, in a fixed priority order.
 *
 * Like gap detection, this is plain code — no LLM. It serves two readers:
 *
 *   - the conversation agent, which receives the open gaps as its
 *     authoritative to-do list and decides for itself how to work through
 *     them (what to ask, what to propose, how to group it);
 *   - anyone reading a `partial` result, where `openGaps` lists exactly what
 *     the schema still lacks.
 *
 * The id IS the gap id, so an open gap in a `partial` result can be traced
 * back to the exact gap that produced it, and the same unresolved gap keeps a
 * stable id across turns.
 */
import { detectGaps, gapId, type Gap, type GapScope } from "./gaps.js";
import type { WorkflowGraph } from "../schema/workflow.js";

export interface OpenGap {
  /** Stable id — identical to the underlying gap's id. */
  id: string;
  /** The gap itself. */
  gap: Gap;
  /** What is unknown, as a question a person could answer. */
  description: string;
}

/**
 * Lower rank = more important to resolve first. The brief (problem, goal,
 * who it is for) comes before any structure — there is nothing to design
 * against, and no way to size the design, without it. Types come before start/end because a type answer can resolve the
 * suppressed start/end gaps; the workflow name never blocks anything and
 * goes last.
 */
export const GAP_PRIORITY: Record<Gap["kind"], number> = {
  missing_problem: 0,
  missing_goal: 1,
  missing_task_fact: 2,
  missing_technical_level: 3,
  unexplored_idea: 4,
  missing_node_type: 5,
  no_start_node: 6,
  no_end_node: 7,
  missing_node_label: 8,
  unlabeled_branch: 9,
  dead_end: 10,
  exitless_cycle: 11,
  unreachable_nodes: 12,
  missing_workflow_name: 13,
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

/** The plain-language description of one gap. */
export function describeGap(wf: WorkflowGraph, gap: Gap): string {
  switch (gap.kind) {
    case "missing_problem":
      return "What problem or need is this workflow meant to address? What is going wrong, or missing, today?";
    case "missing_goal":
      return "What would a good outcome look like — how will the person know the workflow is working?";
    case "missing_task_fact":
      switch (gap.field) {
        case "inputShape":
          return "What would the workflow act on, and in what form — structured records (forms, tables, fields) or free-form material (emails, documents, conversations), or a mix?";
        case "rulesSpecifiable":
          return "Could the person write down the rules for handling every case completely, so that someone — or a script — could follow them without judgment: fully, mostly, partly, or not at all?";
        case "variability":
          return "How much do the cases vary — mostly the same each time, somewhat different, or every one different?";
        case "errorCost":
          return "What happens when a step gets it wrong — a minor annoyance, real rework or cost, or serious harm?";
        case "auditability":
          return "Does each result need to be explainable afterwards?";
      }
    // falls through for exhaustiveness
    case "missing_technical_level":
      return "How comfortable is the person with technical tools — do they write code or scripts, configure software, or mostly use everyday apps? This sets how complex the workflow can be and how later suggestions are explained.";
    case "unexplored_idea": {
      const idea = wf.ideas.find((i) => i.id === gap.ideaId);
      return `The person has an idea — ${idea ? `"${idea.summary}"` : gap.ideaId} — but not why they think it would help, or what they are unsure about. What is the reasoning behind it, and what are the doubts?`;
    }
    case "missing_workflow_name":
      return "What should this workflow be called?";
    case "missing_node_type":
      return `Is ${describeNode(wf, gap.nodeId)} the starting point of the workflow, an end point, a task someone performs, or a decision with multiple outcomes?`;
    case "missing_node_label":
      return `The step "${gap.nodeId}" has no label. What happens in this step?`;
    case "no_start_node":
      return wf.nodes.length === 0
        ? "There are no steps yet. What should the first step be, and what triggers it?"
        : "None of the steps is marked as the starting point. Where does this workflow begin?";
    case "no_end_node":
      return wf.nodes.length === 0
        ? "There are no steps yet. What should the final step or outcome be?"
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
 * Detect and describe every open gap for `scope`, in priority order. Sorting
 * is stable: gaps of equal priority keep the deterministic order
 * `detectGaps()` produced them in. Empty exactly when the workflow is
 * complete for that scope.
 */
export function listOpenGaps(
  wf: WorkflowGraph,
  scope: GapScope = "design",
  gaps: Gap[] = detectGaps(wf, scope),
): OpenGap[] {
  return gaps
    .map((gap, position) => ({ gap, position }))
    .sort(
      (a, b) =>
        GAP_PRIORITY[a.gap.kind] - GAP_PRIORITY[b.gap.kind] || a.position - b.position,
    )
    .map(({ gap }) => ({ id: gapId(gap), gap, description: describeGap(wf, gap) }));
}
