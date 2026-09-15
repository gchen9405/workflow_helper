/**
 * Deterministic motif detection — multi-node improvement shapes.
 *
 * Pure graph code over (workflow graph, node profiles); no LLM. Runs AFTER
 * the clarification loop so detectors see final attribute values. All
 * detectors are cycle-safe: traversals carry visited sets, and the loop
 * detector is Tarjan SCC (adapted from the preprocessor's `gaps.ts` — the
 * algorithm is not exported there). The graph is never assumed to be a DAG.
 *
 * Detectors and their firing rules (conservative: a node whose taskClass or
 * actorKind is unknown never qualifies — never guess):
 *
 * | Motif                      | Fires when                                              |
 * |----------------------------|---------------------------------------------------------|
 * | manual_data_transfer_chain | ≥2 connected data-handling steps done by humans          |
 * | approval_chain             | 2+ approval steps within 3 hops, no approval in between  |
 * | notification_tail          | a notification whose entire onward flow is notify/file/end |
 * | repeated_similar_tasks     | ≥2 steps sharing (taskClass, actor); adjacency not needed |
 * | long_manual_chain          | ≥3 same-actor human tasks in an unbranching run          |
 * | rework_loop                | a cycle containing a review/verification/evaluation step |
 *
 * One deliberate looseness in `long_manual_chain`: nodes whose `actor`
 * string is null group together when their actorKind is human — the chain
 * premise (an unbroken manual block) holds regardless of WHICH human, and
 * requiring named actors would blind the detector on exactly the text
 * inputs that omit them.
 */
import type { WorkflowEdge, WorkflowGraph } from "workflow-preprocessor/core";
import type { NodeProfile } from "../schema/profile.js";
import type { TaskClass } from "../schema/taxonomy.js";
import { motifId, type Motif, type MotifKind } from "../schema/motif.js";

const DATA_HANDLING_CLASSES: readonly TaskClass[] = [
  "data_extraction",
  "data_entry",
  "data_transfer",
];

const TAIL_CLASSES: readonly TaskClass[] = [
  "communication_notification",
  "archiving_records",
];

const REVIEW_CLASSES: readonly TaskClass[] = [
  "verification_check",
  "document_review",
  "quality_inspection",
  "approval_decision",
  "evaluation_benchmarking",
];

const NON_REPEATABLE_CLASSES: readonly TaskClass[] = ["other", "physical_task"];

interface Ctx {
  wf: WorkflowGraph;
  profile: Map<string, NodeProfile>;
  out: Map<string, WorkflowEdge[]>;
  incoming: Map<string, WorkflowEdge[]>;
}

function buildCtx(wf: WorkflowGraph, profiles: NodeProfile[]): Ctx {
  const known = new Set(wf.nodes.map((n) => n.id));
  const out = new Map<string, WorkflowEdge[]>(wf.nodes.map((n) => [n.id, []]));
  const incoming = new Map<string, WorkflowEdge[]>(wf.nodes.map((n) => [n.id, []]));
  for (const edge of wf.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    out.get(edge.from)!.push(edge);
    incoming.get(edge.to)!.push(edge);
  }
  return { wf, profile: new Map(profiles.map((p) => [p.nodeId, p])), out, incoming };
}

function taskClassOf(ctx: Ctx, nodeId: string): TaskClass | null {
  return ctx.profile.get(nodeId)?.taskClass.value ?? null;
}

function actorKindOf(ctx: Ctx, nodeId: string): string | null {
  return ctx.profile.get(nodeId)?.attributes.actorKind.value ?? null;
}

function labelOf(ctx: Ctx, nodeId: string): string {
  const node = ctx.wf.nodes.find((n) => n.id === nodeId);
  return node?.label ?? nodeId;
}

function edgesWithin(ctx: Ctx, members: Set<string>): string[] {
  return ctx.wf.edges
    .filter((e) => members.has(e.from) && members.has(e.to))
    .map((e) => e.id);
}

function make(kind: MotifKind, nodeIds: string[], edgeIds: string[], evidence: string): Motif {
  return { id: motifId(kind, nodeIds), kind, nodeIds, edgeIds, evidence };
}

// ---------------------------------------------------------------------------
// manual_data_transfer_chain
// ---------------------------------------------------------------------------

/** Longest simple directed path inside a small induced subgraph (DFS). */
function longestSimplePath(members: Set<string>, out: Map<string, string[]>): string[] {
  let best: string[] = [];
  const walk = (node: string, path: string[], seen: Set<string>): void => {
    if (path.length > best.length) best = [...path];
    for (const next of out.get(node) ?? []) {
      if (!members.has(next) || seen.has(next)) continue;
      seen.add(next);
      path.push(next);
      walk(next, path, seen);
      path.pop();
      seen.delete(next);
    }
  };
  for (const start of [...members].sort()) {
    walk(start, [start], new Set([start]));
  }
  return best;
}

function detectManualDataTransferChains(ctx: Ctx): Motif[] {
  const eligible = new Set(
    ctx.wf.nodes
      .map((n) => n.id)
      .filter((id) => {
        const cls = taskClassOf(ctx, id);
        const actor = actorKindOf(ctx, id);
        return (
          cls !== null &&
          DATA_HANDLING_CLASSES.includes(cls) &&
          (actor === "human" || actor === "mixed")
        );
      }),
  );

  // Induced directed adjacency + undirected adjacency for weak components.
  const inducedOut = new Map<string, string[]>();
  const undirected = new Map<string, Set<string>>();
  for (const id of eligible) {
    inducedOut.set(id, []);
    undirected.set(id, new Set());
  }
  let hasEdge = false;
  for (const edge of ctx.wf.edges) {
    if (!eligible.has(edge.from) || !eligible.has(edge.to)) continue;
    inducedOut.get(edge.from)!.push(edge.to);
    undirected.get(edge.from)!.add(edge.to);
    undirected.get(edge.to)!.add(edge.from);
    hasEdge = true;
  }
  if (!hasEdge) return [];

  const motifs: Motif[] = [];
  const seen = new Set<string>();
  for (const start of [...eligible].sort()) {
    if (seen.has(start)) continue;
    // Weakly-connected component via BFS on the undirected view.
    const component = new Set<string>([start]);
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of undirected.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          component.add(next);
          queue.push(next);
        }
      }
    }
    if (component.size < 2 || edgesWithin(ctx, component).length === 0) continue;

    const path = longestSimplePath(component, inducedOut);
    const rest = [...component].filter((id) => !path.includes(id)).sort();
    const ordered = [...path, ...rest];
    motifs.push(
      make(
        "manual_data_transfer_chain",
        ordered,
        edgesWithin(ctx, component),
        `${component.size} connected manual data-handling steps (${ordered
          .map((id) => labelOf(ctx, id))
          .join(" → ")})`,
      ),
    );
  }
  return motifs;
}

// ---------------------------------------------------------------------------
// approval_chain
// ---------------------------------------------------------------------------

const APPROVAL_CHAIN_MAX_HOPS = 3;

function detectApprovalChains(ctx: Ctx): Motif[] {
  const approvals = ctx.wf.nodes
    .map((n) => n.id)
    .filter((id) => taskClassOf(ctx, id) === "approval_decision");
  if (approvals.length < 2) return [];
  const approvalSet = new Set(approvals);

  /** Is approval `b` within the hop limit of `a`, with no approval between? */
  const linked = (a: string, b: string): boolean => {
    const visited = new Set<string>([a]);
    let frontier = [a];
    for (let depth = 1; depth <= APPROVAL_CHAIN_MAX_HOPS; depth++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const edge of ctx.out.get(current) ?? []) {
          if (edge.to === b) return true;
          if (visited.has(edge.to)) continue;
          visited.add(edge.to);
          // Never traverse THROUGH an approval — it starts its own pair.
          if (!approvalSet.has(edge.to)) next.push(edge.to);
        }
      }
      frontier = next;
    }
    return false;
  };

  // Union-find over approvals; linked pairs merge into chains.
  const parent = new Map<string, string>(approvals.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const a of approvals) {
    for (const b of approvals) {
      if (a !== b && linked(a, b)) union(a, b);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of approvals) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }

  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => {
      const sorted = [...group].sort();
      return make(
        "approval_chain",
        sorted,
        [],
        `${sorted.length} approval steps within ${APPROVAL_CHAIN_MAX_HOPS} hops of each other (${sorted
          .map((id) => labelOf(ctx, id))
          .join(", ")})`,
      );
    });
}

// ---------------------------------------------------------------------------
// notification_tail
// ---------------------------------------------------------------------------

function detectNotificationTails(ctx: Ctx): Motif[] {
  const nodeById = new Map(ctx.wf.nodes.map((n) => [n.id, n]));
  const candidates: Motif[] = [];

  for (const node of ctx.wf.nodes) {
    if (taskClassOf(ctx, node.id) !== "communication_notification") continue;

    // Forward closure (visited-set BFS, so cycles terminate).
    const closure = new Set<string>();
    const queue = (ctx.out.get(node.id) ?? []).map((e) => e.to);
    let qualifies = true;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === node.id || closure.has(current)) continue;
      closure.add(current);
      const type = nodeById.get(current)?.type ?? null;
      const cls = taskClassOf(ctx, current);
      if (type !== "end" && (cls === null || !TAIL_CLASSES.includes(cls))) {
        qualifies = false;
        break;
      }
      for (const edge of ctx.out.get(current) ?? []) queue.push(edge.to);
    }
    if (!qualifies) continue;

    const members = new Set([node.id, ...closure]);
    candidates.push(
      make(
        "notification_tail",
        [node.id, ...[...closure].sort()],
        edgesWithin(ctx, members),
        `after "${labelOf(ctx, node.id)}" the workflow only notifies, files, or ends`,
      ),
    );
  }

  // A tail nested inside a larger tail is the same finding — keep maximal ones.
  return candidates.filter(
    (motif) =>
      !candidates.some(
        (other) =>
          other !== motif && motif.nodeIds.every((id) => other.nodeIds.includes(id)),
      ),
  );
}

// ---------------------------------------------------------------------------
// repeated_similar_tasks
// ---------------------------------------------------------------------------

function detectRepeatedSimilarTasks(ctx: Ctx): Motif[] {
  const groups = new Map<string, string[]>();
  for (const node of ctx.wf.nodes) {
    const cls = taskClassOf(ctx, node.id);
    if (cls === null || NON_REPEATABLE_CLASSES.includes(cls)) continue;
    if (node.actor === null) continue;
    const key = `${cls}|${node.actor.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), node.id]);
  }

  return [...groups.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([key, ids]) => {
      const [cls] = key.split("|");
      const sorted = [...ids].sort();
      const actor = ctx.wf.nodes.find((n) => n.id === sorted[0])?.actor ?? "the same actor";
      return make(
        "repeated_similar_tasks",
        sorted,
        [],
        `${sorted.length} similar steps (${cls}) performed by ${actor}`,
      );
    });
}

// ---------------------------------------------------------------------------
// long_manual_chain
// ---------------------------------------------------------------------------

const LONG_CHAIN_MIN_NODES = 3;

function detectLongManualChains(ctx: Ctx): Motif[] {
  const nodeById = new Map(ctx.wf.nodes.map((n) => [n.id, n]));
  const eligible = (id: string): boolean =>
    nodeById.get(id)?.type === "task" && actorKindOf(ctx, id) === "human";
  const actorKey = (id: string): string =>
    nodeById.get(id)?.actor?.trim().toLowerCase() ?? "(unknown)";

  /** The single outgoing edge of an unbranching node, else null. */
  const soleEdge = (id: string): WorkflowEdge | null => {
    const edges = ctx.out.get(id) ?? [];
    return edges.length === 1 ? edges[0] : null;
  };

  /** Could `id` be a non-head link of a chain with this actor key? */
  const hasChainPredecessor = (id: string, key: string): boolean =>
    (ctx.incoming.get(id) ?? []).some((edge) => {
      const prev = edge.from;
      return (
        eligible(prev) &&
        actorKey(prev) === key &&
        soleEdge(prev)?.to === id
      );
    });

  const motifs: Motif[] = [];
  for (const node of ctx.wf.nodes) {
    if (!eligible(node.id)) continue;
    const key = actorKey(node.id);
    if (hasChainPredecessor(node.id, key)) continue; // not maximal — a longer chain covers it

    // Walk forward: each non-final link must be unbranching (out-degree 1).
    const path = [node.id];
    const edges: string[] = [];
    const seen = new Set(path);
    for (;;) {
      const edge = soleEdge(path[path.length - 1]);
      if (!edge) break;
      const next = edge.to;
      if (seen.has(next) || !eligible(next) || actorKey(next) !== key) break;
      path.push(next);
      edges.push(edge.id);
      seen.add(next);
    }

    if (path.length >= LONG_CHAIN_MIN_NODES) {
      const actor = nodeById.get(node.id)?.actor;
      motifs.push(
        make(
          "long_manual_chain",
          path,
          edges,
          `${path.length} manual steps in an unbroken run by ${actor ?? "the same person"}`,
        ),
      );
    }
  }
  return motifs;
}

// ---------------------------------------------------------------------------
// rework_loop
// ---------------------------------------------------------------------------

/**
 * Tarjan's strongly connected components, filtered to cycle-bearing ones
 * (size > 1, or a self-loop). Adapted from the preprocessor's gap detector.
 */
function cycleSccs(ctx: Ctx): string[][] {
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

    for (const edge of ctx.out.get(v) ?? []) {
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

  for (const node of ctx.wf.nodes) {
    if (!index.has(node.id)) strongconnect(node.id);
  }

  return sccs.filter(
    (scc) =>
      scc.length > 1 ||
      (ctx.out.get(scc[0]) ?? []).some((edge) => edge.to === scc[0]),
  );
}

function detectReworkLoops(ctx: Ctx): Motif[] {
  const motifs: Motif[] = [];
  for (const scc of cycleSccs(ctx)) {
    const reviewers = scc.filter((id) => {
      const cls = taskClassOf(ctx, id);
      return cls !== null && REVIEW_CLASSES.includes(cls);
    });
    if (reviewers.length === 0) continue;
    const sorted = [...scc].sort();
    const members = new Set(scc);
    motifs.push(
      make(
        "rework_loop",
        sorted,
        edgesWithin(ctx, members),
        `a loop of ${sorted.length} step(s) sends work back through "${labelOf(ctx, reviewers.sort()[0])}"`,
      ),
    );
  }
  return motifs;
}

// ---------------------------------------------------------------------------

/** Run every detector, in a fixed order. Deterministic. */
export function detectMotifs(wf: WorkflowGraph, profiles: NodeProfile[]): Motif[] {
  const ctx = buildCtx(wf, profiles);
  return [
    ...detectManualDataTransferChains(ctx),
    ...detectApprovalChains(ctx),
    ...detectNotificationTails(ctx),
    ...detectRepeatedSimilarTasks(ctx),
    ...detectLongManualChains(ctx),
    ...detectReworkLoops(ctx),
  ];
}
