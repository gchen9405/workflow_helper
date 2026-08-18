/**
 * Deterministic gap detection — the clarification loop's termination condition.
 *
 * This is plain, unit-tested graph code. No LLM is involved anywhere in this
 * file. A workflow is COMPLETE exactly when `detectGaps()` returns an empty
 * list; until then, each gap maps 1:1 to a user-facing clarifying question
 * (see `./questions.ts`).
 *
 * The detectors and their firing rules:
 *
 * | Gap                    | Fires when                                                            |
 * |------------------------|-----------------------------------------------------------------------|
 * | missing_node_type      | a node's `type` is null                                               |
 * | missing_node_label     | a node's `label` is null                                              |
 * | no_start_node          | no node is typed `start` AND no node has an unknown type (*)          |
 * | no_end_node            | no node is typed `end` AND no node has an unknown type (*)            |
 * | unreachable_nodes      | start nodes exist, and some nodes are not reachable from any of them  |
 * | dead_end               | a node with a known non-`end` type has no outgoing edges              |
 * | unlabeled_branch       | a node has ≥ 2 outgoing edges and at least one of them is unlabeled   |
 * | exitless_cycle         | end nodes exist, and a cycle cannot reach any of them (**)            |
 * | missing_workflow_name  | the workflow `name` is null                                           |
 *
 * (*) While any node's type is unknown, answering the missing_node_type
 *     question may reveal the start/end, so asking "where does it start?"
 *     in the same round would be redundant. Once all types are known and
 *     there is still no start/end, the gap fires. With zero nodes both fire
 *     immediately — the questions become "what's the first/last step?".
 *
 * (**) A cycle is a strongly connected component with more than one node, or
 *     a single node with a self-loop. The check is suppressed while no end
 *     node exists (no_end_node already covers that situation) to avoid
 *     asking two versions of the same question.
 *
 * `description` and `actor` on nodes are optional enrichment — null there is
 * NOT a gap, otherwise every workflow would generate unbounded questions.
 *
 * Structural defects (dangling edges, duplicate ids) are deliberately NOT
 * gaps: they are machine-output errors handled by the internal repair loop
 * (`../schema/workflow.ts` → validateGraphIntegrity). Gap detection may
 * assume an integrity-valid graph, but is written defensively anyway (edges
 * with unknown endpoints are ignored).
 */
import type { WorkflowEdge, WorkflowGraph } from "../schema/workflow.js";

export type Gap =
  | { kind: "missing_workflow_name" }
  | { kind: "missing_node_type"; nodeId: string }
  | { kind: "missing_node_label"; nodeId: string }
  | { kind: "no_start_node" }
  | { kind: "no_end_node" }
  | { kind: "unreachable_nodes"; nodeIds: string[] }
  | { kind: "dead_end"; nodeId: string }
  | { kind: "unlabeled_branch"; nodeId: string; edgeIds: string[] }
  | { kind: "exitless_cycle"; nodeIds: string[] };

/**
 * Stable identifier for a gap. Used as the question id, so the same gap keeps
 * the same id across clarification rounds.
 */
export function gapId(gap: Gap): string {
  switch (gap.kind) {
    case "missing_workflow_name":
    case "no_start_node":
    case "no_end_node":
      return gap.kind;
    case "missing_node_type":
    case "missing_node_label":
    case "dead_end":
      return `${gap.kind}:${gap.nodeId}`;
    case "unlabeled_branch":
      return `${gap.kind}:${gap.nodeId}`;
    case "unreachable_nodes":
    case "exitless_cycle":
      return `${gap.kind}:${[...gap.nodeIds].sort().join(",")}`;
  }
}

/** Adjacency of outgoing edges, ignoring edges whose endpoints are unknown. */
function outgoingMap(wf: WorkflowGraph): Map<string, WorkflowEdge[]> {
  const known = new Set(wf.nodes.map((n) => n.id));
  const map = new Map<string, WorkflowEdge[]>(wf.nodes.map((n) => [n.id, []]));
  for (const edge of wf.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    map.get(edge.from)!.push(edge);
  }
  return map;
}

/** Adjacency of incoming edges, ignoring edges whose endpoints are unknown. */
function incomingMap(wf: WorkflowGraph): Map<string, WorkflowEdge[]> {
  const known = new Set(wf.nodes.map((n) => n.id));
  const map = new Map<string, WorkflowEdge[]>(wf.nodes.map((n) => [n.id, []]));
  for (const edge of wf.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    map.get(edge.to)!.push(edge);
  }
  return map;
}

/** Breadth-first forward reachability from a set of seed nodes (seeds included). */
function reachableFrom(wf: WorkflowGraph, seeds: string[]): Set<string> {
  const out = outgoingMap(wf);
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of out.get(current) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
}

/** Breadth-first reverse reachability: all nodes from which some seed is reachable. */
function canReach(wf: WorkflowGraph, seeds: string[]): Set<string> {
  const incoming = incomingMap(wf);
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of incoming.get(current) ?? []) {
      if (!seen.has(edge.from)) {
        seen.add(edge.from);
        queue.push(edge.from);
      }
    }
  }
  return seen;
}

/**
 * Tarjan's strongly connected components, filtered down to the ones that
 * actually contain a cycle: SCCs with more than one node, or a single node
 * with a self-loop.
 */
function cycleSccs(wf: WorkflowGraph): string[][] {
  const out = outgoingMap(wf);
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const edge of out.get(v) ?? []) {
      const w = edge.to;
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      sccs.push(scc);
    }
  };

  for (const node of wf.nodes) {
    if (!index.has(node.id)) strongconnect(node.id);
  }

  return sccs.filter(
    (scc) =>
      scc.length > 1 ||
      (out.get(scc[0]) ?? []).some((edge) => edge.to === scc[0]),
  );
}

/**
 * Run every detector over the graph and return all gaps, in a deterministic
 * order (field gaps in node-list order, then structural gaps).
 */
export function detectGaps(wf: WorkflowGraph): Gap[] {
  const gaps: Gap[] = [];
  const out = outgoingMap(wf);

  const hasUnknownType = wf.nodes.some((n) => n.type === null);
  const startIds = wf.nodes.filter((n) => n.type === "start").map((n) => n.id);
  const endIds = wf.nodes.filter((n) => n.type === "end").map((n) => n.id);

  // Per-node field gaps, in node-list order.
  for (const node of wf.nodes) {
    if (node.type === null) gaps.push({ kind: "missing_node_type", nodeId: node.id });
    if (node.label === null) gaps.push({ kind: "missing_node_label", nodeId: node.id });
  }

  // Entry/exit points. Suppressed while node types are still unknown — those
  // answers may reveal the start/end (see the module doc).
  if (startIds.length === 0 && !hasUnknownType) gaps.push({ kind: "no_start_node" });
  if (endIds.length === 0 && !hasUnknownType) gaps.push({ kind: "no_end_node" });

  // Unlabeled branches: any branching node where some outgoing edge lacks a
  // condition. Applies to decisions and to any other node that fans out — a
  // deliberate parallel split must be labeled too (e.g. "in parallel").
  for (const node of wf.nodes) {
    const edges = out.get(node.id) ?? [];
    if (edges.length >= 2) {
      const unlabeled = edges.filter((e) => e.label === null).map((e) => e.id);
      if (unlabeled.length > 0) {
        gaps.push({ kind: "unlabeled_branch", nodeId: node.id, edgeIds: unlabeled });
      }
    }
  }

  // Dead ends: a known non-end node with nowhere to go. Nodes with an unknown
  // type are skipped — the missing_node_type question resolves them first
  // (if the user says "end", there is no dead end; if "task", this fires
  // next round).
  for (const node of wf.nodes) {
    if (node.type !== null && node.type !== "end" && (out.get(node.id) ?? []).length === 0) {
      gaps.push({ kind: "dead_end", nodeId: node.id });
    }
  }

  // Exit-less cycles: a cycle from which no end node is reachable. Only
  // checked when end nodes exist (otherwise no_end_node already covers it).
  if (endIds.length > 0) {
    const reachesEnd = canReach(wf, endIds);
    for (const scc of cycleSccs(wf)) {
      // Within an SCC, either every node reaches an end or none does, so
      // checking one member suffices — but check all for clarity.
      if (!scc.some((id) => reachesEnd.has(id))) {
        gaps.push({ kind: "exitless_cycle", nodeIds: [...scc].sort() });
      }
    }
  }

  // Unreachable nodes: only meaningful once start nodes exist.
  if (startIds.length > 0) {
    const reachable = reachableFrom(wf, startIds);
    const unreachable = wf.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
    if (unreachable.length > 0) {
      gaps.push({ kind: "unreachable_nodes", nodeIds: unreachable });
    }
  }

  // Workflow name last — it never blocks understanding the flow itself.
  if (wf.name === null) gaps.push({ kind: "missing_workflow_name" });

  return gaps;
}
