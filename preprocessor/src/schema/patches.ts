/**
 * Patches: the only way user answers ever change the schema.
 *
 * The answer-application LLM call (`../pipeline/clarify.ts`) does not edit
 * the workflow object. It emits a list of *patch operations*, and this module
 * applies them deterministically:
 *
 *  - every patch is validated against the current graph (unknown node ids,
 *    duplicate ids, invalid node types are rejected with a precise error);
 *  - every field a patch sets is stamped with provenance `"user_elicited"`;
 *  - application is pure — the input workflow is never mutated.
 *
 * Rejected-patch errors feed the machine-facing repair loop: they are sent
 * back to the model, which retries. The user never sees them.
 */
import { z } from "zod";
import {
  NODE_TYPES,
  provenancePath,
  WorkflowEdgeSchema,
  WorkflowNodeSchema,
  type NodeField,
  type NodeType,
  type Workflow,
} from "./workflow.js";

export const PatchSchema = z.discriminatedUnion("op", [
  /** Set the workflow-level name or description. */
  z.object({
    op: z.literal("set_workflow_field"),
    field: z.enum(["name", "description"]),
    value: z.string(),
  }),
  /** Set a field on an existing node. For `field: "type"` the value must be a valid node type. */
  z.object({
    op: z.literal("set_node_field"),
    nodeId: z.string(),
    field: z.enum(["type", "label", "description", "actor"]),
    value: z.string(),
  }),
  /** Set the label (branch condition) of an existing edge. */
  z.object({
    op: z.literal("set_edge_label"),
    edgeId: z.string(),
    value: z.string(),
  }),
  /** Add a new node. Unknown fields stay null — the model must not invent them. */
  z.object({
    op: z.literal("add_node"),
    node: WorkflowNodeSchema,
  }),
  /** Add a new edge between existing nodes (including ones added earlier in the same patch list). */
  z.object({
    op: z.literal("add_edge"),
    edge: WorkflowEdgeSchema,
  }),
  /** Remove an edge (only when the user says a connection is wrong). */
  z.object({
    op: z.literal("remove_edge"),
    edgeId: z.string(),
  }),
  /** Remove a node and all its incident edges (only when the user says a step is wrong). */
  z.object({
    op: z.literal("remove_node"),
    nodeId: z.string(),
  }),
]);
export type Patch = z.infer<typeof PatchSchema>;

/** The structured output of the answer-application LLM call. */
export const AnswerApplicationSchema = z.object({
  patches: z.array(PatchSchema),
});
export type AnswerApplication = z.infer<typeof AnswerApplicationSchema>;

export interface PatchApplication {
  /** The new workflow. Untouched patches leave it identical to a deep copy of the input. */
  workflow: Workflow;
  /** Validation errors for rejected patches (machine-facing; drive the repair loop). */
  errors: string[];
  /** Number of patches that applied cleanly. */
  appliedCount: number;
}

const NODE_FIELDS: readonly NodeField[] = ["type", "label", "description", "actor"];

/**
 * Apply patches in order to a deep copy of `workflow`.
 *
 * Patches are applied sequentially, so later patches may reference nodes and
 * edges created by earlier ones. A patch that fails validation is recorded in
 * `errors` and skipped; the remaining patches still apply. Callers that need
 * all-or-nothing semantics (the repair loop does) treat a non-empty `errors`
 * as a failed attempt and retry the LLM call.
 */
export function applyPatches(workflow: Workflow, patches: Patch[]): PatchApplication {
  const wf: Workflow = structuredClone(workflow);
  const errors: string[] = [];
  let appliedCount = 0;

  for (const [index, patch] of patches.entries()) {
    const where = `patch ${index + 1} (${patch.op})`;

    switch (patch.op) {
      case "set_workflow_field": {
        const value = patch.value.trim();
        if (value === "") {
          errors.push(`${where}: value must be non-empty`);
          break;
        }
        wf[patch.field] = value;
        wf.provenance[provenancePath.workflowField(patch.field)] = "user_elicited";
        appliedCount++;
        break;
      }

      case "set_node_field": {
        const node = wf.nodes.find((n) => n.id === patch.nodeId);
        if (!node) {
          errors.push(`${where}: node "${patch.nodeId}" does not exist`);
          break;
        }
        const value = patch.value.trim();
        if (value === "") {
          errors.push(`${where}: value must be non-empty`);
          break;
        }
        if (patch.field === "type") {
          if (!(NODE_TYPES as readonly string[]).includes(value)) {
            errors.push(
              `${where}: "${value}" is not a node type (expected one of: ${NODE_TYPES.join(", ")})`,
            );
            break;
          }
          node.type = value as NodeType;
        } else {
          node[patch.field] = value;
        }
        wf.provenance[provenancePath.nodeField(patch.nodeId, patch.field)] = "user_elicited";
        appliedCount++;
        break;
      }

      case "set_edge_label": {
        const edge = wf.edges.find((e) => e.id === patch.edgeId);
        if (!edge) {
          errors.push(`${where}: edge "${patch.edgeId}" does not exist`);
          break;
        }
        const value = patch.value.trim();
        if (value === "") {
          errors.push(`${where}: value must be non-empty`);
          break;
        }
        edge.label = value;
        wf.provenance[provenancePath.edgeLabel(patch.edgeId)] = "user_elicited";
        appliedCount++;
        break;
      }

      case "add_node": {
        const id = patch.node.id.trim();
        if (id === "") {
          errors.push(`${where}: node id must be non-empty`);
          break;
        }
        if (wf.nodes.some((n) => n.id === id)) {
          errors.push(`${where}: node id "${id}" already exists`);
          break;
        }
        const node = structuredClone(patch.node);
        node.id = id;
        wf.nodes.push(node);
        wf.provenance[provenancePath.node(id)] = "user_elicited";
        for (const field of NODE_FIELDS) {
          if (node[field] !== null) {
            wf.provenance[provenancePath.nodeField(id, field)] = "user_elicited";
          }
        }
        appliedCount++;
        break;
      }

      case "add_edge": {
        const id = patch.edge.id.trim();
        if (id === "") {
          errors.push(`${where}: edge id must be non-empty`);
          break;
        }
        if (wf.edges.some((e) => e.id === id)) {
          errors.push(`${where}: edge id "${id}" already exists`);
          break;
        }
        const missing = [patch.edge.from, patch.edge.to].filter(
          (nodeId) => !wf.nodes.some((n) => n.id === nodeId),
        );
        if (missing.length > 0) {
          errors.push(
            `${where}: node(s) ${missing.map((m) => `"${m}"`).join(", ")} do not exist`,
          );
          break;
        }
        const edge = structuredClone(patch.edge);
        edge.id = id;
        wf.edges.push(edge);
        wf.provenance[provenancePath.edge(id)] = "user_elicited";
        if (edge.label !== null) {
          wf.provenance[provenancePath.edgeLabel(id)] = "user_elicited";
        }
        appliedCount++;
        break;
      }

      case "remove_edge": {
        const at = wf.edges.findIndex((e) => e.id === patch.edgeId);
        if (at < 0) {
          errors.push(`${where}: edge "${patch.edgeId}" does not exist`);
          break;
        }
        wf.edges.splice(at, 1);
        delete wf.provenance[provenancePath.edge(patch.edgeId)];
        delete wf.provenance[provenancePath.edgeLabel(patch.edgeId)];
        appliedCount++;
        break;
      }

      case "remove_node": {
        const at = wf.nodes.findIndex((n) => n.id === patch.nodeId);
        if (at < 0) {
          errors.push(`${where}: node "${patch.nodeId}" does not exist`);
          break;
        }
        wf.nodes.splice(at, 1);
        delete wf.provenance[provenancePath.node(patch.nodeId)];
        for (const field of NODE_FIELDS) {
          delete wf.provenance[provenancePath.nodeField(patch.nodeId, field)];
        }
        // Removing a node removes its incident edges — dangling edges are
        // never allowed to exist.
        const incident = wf.edges.filter(
          (e) => e.from === patch.nodeId || e.to === patch.nodeId,
        );
        for (const edge of incident) {
          delete wf.provenance[provenancePath.edge(edge.id)];
          delete wf.provenance[provenancePath.edgeLabel(edge.id)];
        }
        wf.edges = wf.edges.filter(
          (e) => e.from !== patch.nodeId && e.to !== patch.nodeId,
        );
        appliedCount++;
        break;
      }
    }
  }

  return { workflow: wf, errors, appliedCount };
}
