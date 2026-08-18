/**
 * The workflow schema — the single object that holds all pipeline state.
 *
 * A workflow is a directed graph with FLAT node and edge lists. Flat lists
 * (rather than nesting) mean cycles and reconverging branches are directly
 * representable: an edge is just `{ from, to }`, so `pack -> check_stock`
 * (a loop back) or `approve -> notify` / `reject -> notify` (a reconvergence)
 * are ordinary rows in the edge list.
 *
 * Every field that extraction cannot read directly off the input is `null`.
 * `null` never means "empty" — it means "unknown, nobody has said". Gap
 * detection (`../pipeline/gaps.ts`) turns nulls and structural defects into
 * user-facing questions; the clarification loop fills them in via patches
 * (`./patches.ts`).
 *
 * Provenance: the final schema records, per filled field, whether the value
 * came from the original input (`"original"`) or was elicited from the user
 * during clarification (`"user_elicited"`). Provenance is a flat map keyed by
 * field paths (see {@link provenancePath}) so the graph itself stays clean.
 */
import { z } from "zod";

/** The closed set of node types the schema understands. */
export const NODE_TYPES = ["start", "end", "task", "decision"] as const;

export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;

/**
 * One step in the workflow.
 *
 * Required-for-completeness fields (gap detection asks about them when null):
 * - `type`  — start | end | task | decision
 * - `label` — what the step is called / does
 *
 * Optional enrichment fields (allowed to stay null in a *validated* schema):
 * - `description` — extra free-text detail about the step
 * - `actor`       — who or what performs the step
 */
export const WorkflowNodeSchema = z.object({
  id: z.string(),
  type: NodeTypeSchema.nullable(),
  label: z.string().nullable(),
  description: z.string().nullable(),
  actor: z.string().nullable(),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

/**
 * One directed transition. `label` carries the branch condition ("yes",
 * "approved", "> $500"). A null label is only a gap when the source node
 * branches (two or more outgoing edges) — a single unlabeled "next" edge is
 * complete as-is.
 */
export const WorkflowEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().nullable(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

/**
 * What the extraction LLM call produces: the graph without provenance.
 * Provenance is stamped by deterministic code afterwards
 * ({@link stampOriginalProvenance}) — the model never writes provenance.
 */
export const ExtractionDraftSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
});
export type ExtractionDraft = z.infer<typeof ExtractionDraftSchema>;

export type Provenance = "original" | "user_elicited";

/** The full schema: the extraction draft plus per-field provenance. */
export interface Workflow extends ExtractionDraft {
  /**
   * Field path -> where the value came from. Only *filled* (non-null) fields
   * and existing entities have entries. Paths are produced exclusively by
   * {@link provenancePath} — never hand-build them.
   */
  provenance: Record<string, Provenance>;
}

/** The graph slice of a workflow — what the deterministic analyses operate on. */
export type WorkflowGraph = Pick<Workflow, "name" | "nodes" | "edges">;

export type NodeField = "type" | "label" | "description" | "actor";
export type WorkflowField = "name" | "description";

/**
 * Canonical provenance field paths.
 *
 * - `workflow.<field>`      — top-level name/description
 * - `node.<id>`             — the node's existence itself
 * - `node.<id>.<field>`     — a node field
 * - `edge.<id>`             — the edge's existence itself
 * - `edge.<id>.label`       — an edge label
 */
export const provenancePath = {
  workflowField: (field: WorkflowField): string => `workflow.${field}`,
  node: (nodeId: string): string => `node.${nodeId}`,
  nodeField: (nodeId: string, field: NodeField): string => `node.${nodeId}.${field}`,
  edge: (edgeId: string): string => `edge.${edgeId}`,
  edgeLabel: (edgeId: string): string => `edge.${edgeId}.label`,
};

const NODE_FIELDS: readonly NodeField[] = ["type", "label", "description", "actor"];

/**
 * Turn an extraction draft into a full Workflow by marking every filled field
 * and every entity as `"original"` (i.e. read off the original input).
 * Deterministic; no LLM involved.
 */
export function stampOriginalProvenance(draft: ExtractionDraft): Workflow {
  const provenance: Record<string, Provenance> = {};
  if (draft.name !== null) provenance[provenancePath.workflowField("name")] = "original";
  if (draft.description !== null) provenance[provenancePath.workflowField("description")] = "original";
  for (const node of draft.nodes) {
    provenance[provenancePath.node(node.id)] = "original";
    for (const field of NODE_FIELDS) {
      if (node[field] !== null) provenance[provenancePath.nodeField(node.id, field)] = "original";
    }
  }
  for (const edge of draft.edges) {
    provenance[provenancePath.edge(edge.id)] = "original";
    if (edge.label !== null) provenance[provenancePath.edgeLabel(edge.id)] = "original";
  }
  return { ...structuredClone(draft), provenance };
}

/**
 * Machine-level structural validation.
 *
 * These are defects an LLM produced in *its own output* — never something to
 * ask the user about. They feed the internal repair loop
 * (`../llm/client.ts`): the errors are sent back to the model and the call is
 * retried. Contrast with gap detection, whose findings are user-facing.
 *
 * Returns a list of human-readable error strings; empty means structurally
 * valid.
 */
export function validateGraphIntegrity(draft: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): string[] {
  const errors: string[] = [];
  const nodeIds = new Set<string>();

  for (const node of draft.nodes) {
    if (node.id.trim() === "") {
      errors.push("a node has an empty id");
      continue;
    }
    if (nodeIds.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of draft.edges) {
    if (edge.id.trim() === "") {
      errors.push("an edge has an empty id");
      continue;
    }
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge id "${edge.id}"`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) {
      errors.push(`edge "${edge.id}" references unknown source node "${edge.from}"`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`edge "${edge.id}" references unknown target node "${edge.to}"`);
    }
  }

  return errors;
}
