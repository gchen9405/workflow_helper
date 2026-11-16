/**
 * Patches: the only way the conversation ever changes the schema.
 *
 * The interpretation call (`../conversation/agent.ts`) does not edit the
 * workflow object. It emits a list of *patch operations*, and this module
 * applies them deterministically:
 *
 *  - every patch is validated against the current graph (unknown node ids,
 *    duplicate ids, invalid node types are rejected with a precise error);
 *  - every field a patch sets is stamped with the given provenance —
 *    `"user_elicited"` for what the person said, `"agent_proposed"` for an
 *    assistant proposal the person accepted;
 *  - application is pure — the input workflow is never mutated.
 *
 * Rejected-patch errors feed the machine-facing repair loop: they are sent
 * back to the model, which retries. The user never sees them.
 */
import { z } from "zod";
import {
  IdeaSchema,
  NODE_TYPES,
  provenancePath,
  TASK_FIELD_VALUES,
  TASK_TEXT_FIELDS,
  TechnicalLevelSchema,
  ToolFamiliaritySchema,
  toolKey,
  WorkflowEdgeSchema,
  WorkflowNodeSchema,
  type NodeField,
  type NodeType,
  type Provenance,
  type Workflow,
} from "./workflow.js";

export const PatchSchema = z.discriminatedUnion("op", [
  /** Set the workflow-level name, description, problem or goal. */
  z.object({
    op: z.literal("set_workflow_field"),
    field: z.enum(["name", "description", "problem", "goal"]),
    value: z.string(),
  }),
  /** Record a stated constraint (tools, people, time, rules). */
  z.object({
    op: z.literal("add_constraint"),
    value: z.string(),
  }),
  /**
   * Set one task characteristic. inputs / frequency take free text; inputShape
   * (structured|unstructured|mixed), rulesSpecifiable (fully|mostly|partly|no),
   * variability and errorCost (low|medium|high) and auditability
   * (required|helpful|not_needed) take exactly one of their values.
   */
  z.object({
    op: z.literal("set_task_field"),
    field: z.enum(["inputs", "inputShape", "rulesSpecifiable", "variability", "errorCost", "frequency", "auditability"]),
    value: z.string(),
  }),
  /** Set the person's technical level (one of none, basic, intermediate, advanced). */
  z.object({
    op: z.literal("set_technical_level"),
    value: TechnicalLevelSchema,
  }),
  /** Set the person's background: their role and domain, in their words. */
  z.object({
    op: z.literal("set_background"),
    value: z.string(),
  }),
  /** Record, or update, how well the person knows one specific tool or technology. */
  z.object({
    op: z.literal("set_tool_familiarity"),
    name: z.string(),
    familiarity: ToolFamiliaritySchema,
  }),
  /** Note something about the person a later stage should know when choosing and explaining resources. */
  z.object({
    op: z.literal("add_profile_note"),
    value: z.string(),
  }),
  /** Record an approach-level idea the person has. Unknown fields stay null. */
  z.object({
    op: z.literal("add_idea"),
    idea: IdeaSchema,
  }),
  /** Set an existing idea's summary, rationale (why they think it helps) or concerns (what they are unsure about). */
  z.object({
    op: z.literal("set_idea_field"),
    ideaId: z.string(),
    field: z.enum(["summary", "rationale", "concerns"]),
    value: z.string(),
  }),
  /** Drop an idea the person has abandoned. */
  z.object({
    op: z.literal("remove_idea"),
    ideaId: z.string(),
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
export function applyPatches(
  workflow: Workflow,
  patches: Patch[],
  source: Provenance = "user_elicited",
): PatchApplication {
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
        wf.provenance[provenancePath.workflowField(patch.field)] = source;
        appliedCount++;
        break;
      }

      case "add_constraint": {
        const value = patch.value.trim();
        if (value === "") {
          errors.push(`${where}: value must be non-empty`);
          break;
        }
        if (wf.constraints.some((c) => c.toLowerCase() === value.toLowerCase())) {
          errors.push(`${where}: constraint "${value}" is already recorded`);
          break;
        }
        wf.provenance[provenancePath.constraint(wf.constraints.length)] = source;
        wf.constraints.push(value);
        appliedCount++;
        break;
      }

      case "set_task_field": {
        const value = patch.value.trim();
        if (value === "") {
          errors.push(`${where}: value must be non-empty`);
          break;
        }
        if ((TASK_TEXT_FIELDS as readonly string[]).includes(patch.field)) {
          wf.task[patch.field as "inputs" | "frequency"] = value;
        } else {
          const field = patch.field as keyof typeof TASK_FIELD_VALUES;
          const allowed: readonly string[] = TASK_FIELD_VALUES[field];
          if (!allowed.includes(value)) {
            errors.push(`${where}: "${value}" is not a value for ${field} (expected one of: ${allowed.join(", ")})`);
            break;
          }
          (wf.task as Record<string, string | null>)[field] = value;
        }
        wf.provenance[provenancePath.taskField(patch.field)] = source;
        appliedCount++;
        break;
      }

      case "set_technical_level": {
        wf.profile.technicalLevel = patch.value;
        wf.provenance[provenancePath.profileField("technicalLevel")] = source;
        appliedCount++;
        break;
      }

      case "set_background": {
        const value = patch.value.trim();
        if (value === "") {
          errors.push(`${where}: value must be non-empty`);
          break;
        }
        wf.profile.background = value;
        wf.provenance[provenancePath.profileField("background")] = source;
        appliedCount++;
        break;
      }

      case "set_tool_familiarity": {
        const name = patch.name.trim();
        if (name === "") {
          errors.push(`${where}: tool name must be non-empty`);
          break;
        }
        const existing = wf.profile.tools.find((t) => toolKey(t.name) === toolKey(name));
        if (existing) {
          existing.familiarity = patch.familiarity;
        } else {
          wf.profile.tools.push({ name, familiarity: patch.familiarity });
        }
        wf.provenance[provenancePath.tool(name)] = source;
        appliedCount++;
        break;
      }

      case "add_profile_note": {
        const value = patch.value.trim();
        if (value === "") {
          errors.push(`${where}: value must be non-empty`);
          break;
        }
        if (wf.profile.notes.some((n) => n.toLowerCase() === value.toLowerCase())) {
          errors.push(`${where}: note "${value}" is already recorded`);
          break;
        }
        wf.provenance[provenancePath.note(wf.profile.notes.length)] = source;
        wf.profile.notes.push(value);
        appliedCount++;
        break;
      }

      case "add_idea": {
        const id = patch.idea.id.trim();
        if (id === "") {
          errors.push(`${where}: idea id must be non-empty`);
          break;
        }
        if (wf.ideas.some((i) => i.id === id)) {
          errors.push(`${where}: idea id "${id}" already exists`);
          break;
        }
        if (patch.idea.summary.trim() === "") {
          errors.push(`${where}: idea summary must be non-empty`);
          break;
        }
        const idea = structuredClone(patch.idea);
        idea.id = id;
        wf.ideas.push(idea);
        wf.provenance[provenancePath.idea(id)] = source;
        if (idea.rationale !== null) wf.provenance[provenancePath.ideaField(id, "rationale")] = source;
        if (idea.concerns !== null) wf.provenance[provenancePath.ideaField(id, "concerns")] = source;
        appliedCount++;
        break;
      }

      case "set_idea_field": {
        const idea = wf.ideas.find((i) => i.id === patch.ideaId);
        if (!idea) {
          errors.push(`${where}: idea "${patch.ideaId}" does not exist`);
          break;
        }
        const value = patch.value.trim();
        if (value === "") {
          errors.push(`${where}: value must be non-empty`);
          break;
        }
        idea[patch.field] = value;
        if (patch.field === "summary") {
          wf.provenance[provenancePath.idea(patch.ideaId)] = source;
        } else {
          wf.provenance[provenancePath.ideaField(patch.ideaId, patch.field)] = source;
        }
        appliedCount++;
        break;
      }

      case "remove_idea": {
        const at = wf.ideas.findIndex((i) => i.id === patch.ideaId);
        if (at < 0) {
          errors.push(`${where}: idea "${patch.ideaId}" does not exist`);
          break;
        }
        wf.ideas.splice(at, 1);
        delete wf.provenance[provenancePath.idea(patch.ideaId)];
        delete wf.provenance[provenancePath.ideaField(patch.ideaId, "rationale")];
        delete wf.provenance[provenancePath.ideaField(patch.ideaId, "concerns")];
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
        wf.provenance[provenancePath.nodeField(patch.nodeId, patch.field)] = source;
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
        wf.provenance[provenancePath.edgeLabel(patch.edgeId)] = source;
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
        wf.provenance[provenancePath.node(id)] = source;
        for (const field of NODE_FIELDS) {
          if (node[field] !== null) {
            wf.provenance[provenancePath.nodeField(id, field)] = source;
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
        wf.provenance[provenancePath.edge(id)] = source;
        if (edge.label !== null) {
          wf.provenance[provenancePath.edgeLabel(id)] = source;
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
