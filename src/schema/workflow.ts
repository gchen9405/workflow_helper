/**
 * The workflow schema — what the person and the assistant build together.
 *
 * On top of the graph it carries the design brief: the `problem` the person
 * is facing, the `goal` (what a good outcome looks like), any stated
 * `constraints`, the person's `profile` — their technical level, their
 * background, the tools they know, and notes on their preferences — and
 * their `ideas`: approach-level thoughts about how to tackle it ("maybe an
 * LLM could triage the reports"), each with the reasoning behind it. Ideas
 * that are concrete steps live in the graph; ideas about approach live
 * here. The `task` section characterizes the work itself — what it acts on,
 * whether its rules can be written down, how much cases vary, what a wrong
 * result costs — which is what a later step uses to weigh a deterministic
 * (scripted, rule-based) approach against an AI-assisted one. The brief
 * is what the workflow is designed against: the profile sets how complex
 * the design may be, and it is what a later stage uses to pick resources
 * that fit the person and explain them at the right level. The graph may
 * well start empty when the person has no ideas yet.
 *
 * A workflow is a directed graph with FLAT node and edge lists. Flat lists
 * (rather than nesting) mean cycles and reconverging branches are directly
 * representable: an edge is just `{ from, to }`, so `pack -> check_stock`
 * (a loop back) or `approve -> notify` / `reject -> notify` (a reconvergence)
 * are ordinary rows in the edge list.
 *
 * Every field that extraction cannot read directly off the input is `null`.
 * `null` never means "empty" — it means "unknown, nobody has said". Gap
 * detection (`../graph/gaps.ts`) turns nulls and structural defects into the
 * assistant's to-do list; the conversation fills them in via patches
 * (`./patches.ts`).
 *
 * Provenance: the final schema records, per filled field and entity, where it
 * came from — the original input (`"original"`), something the person said
 * during the conversation (`"user_elicited"`), or a proposal the assistant
 * made that the person accepted (`"agent_proposed"`). Provenance is a flat
 * map keyed by field paths (see {@link provenancePath}) so the graph itself
 * stays clean.
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
 * How comfortable the person is with technical tools. Sets how complex the
 * workflow may be, and how a later stage explains the resources it suggests.
 *
 * - `none`         — uses everyday apps; no scripting, no configuring software
 * - `basic`        — comfortable configuring tools, following technical
 *                    instructions, maybe a little scripting
 * - `intermediate` — writes scripts or code, sets up integrations, reads docs
 * - `advanced`     — builds systems; automation and infrastructure are routine
 */
export const TECHNICAL_LEVELS = ["none", "basic", "intermediate", "advanced"] as const;
export const TechnicalLevelSchema = z.enum(TECHNICAL_LEVELS);
export type TechnicalLevel = z.infer<typeof TechnicalLevelSchema>;

/** How well the person knows one specific tool or technology. */
export const TOOL_FAMILIARITIES = ["unfamiliar", "basic", "fluent"] as const;
export const ToolFamiliaritySchema = z.enum(TOOL_FAMILIARITIES);
export type ToolFamiliarity = z.infer<typeof ToolFamiliaritySchema>;

export const ToolSchema = z.object({
  /** The tool or technology, as named by the person ("Python", "Jira", "Excel macros"). */
  name: z.string(),
  familiarity: ToolFamiliaritySchema,
});
export type Tool = z.infer<typeof ToolSchema>;

/**
 * The person's profile: who the workflow is for.
 *
 * Required-for-completeness: `technicalLevel` (a gap while null — nothing
 * can be sized without it). Optional enrichment: `background` (their role
 * and domain, in their words), `tools` (specific tools and how well they
 * know them), `notes` (anything else a later stage should know when
 * choosing and explaining resources: preferences, appetite for automation,
 * who else will run the workflow, time they can spend).
 */
export const ProfileSchema = z.object({
  technicalLevel: TechnicalLevelSchema.nullable(),
  background: z.string().nullable(),
  tools: z.array(ToolSchema),
  notes: z.array(z.string()),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * One approach-level idea the person has about tackling the problem — a
 * tool, a technique, a direction — as opposed to a concrete step (which is a
 * node). `rationale` is why they think it would help: a gap while null, so
 * the conversation probes every idea. `concerns` is what they are unsure
 * about: optional enrichment.
 */
export const IdeaSchema = z.object({
  /** Stable snake_case id derived from the idea ("llm_triage"). */
  id: z.string(),
  /** The idea in the person's words. */
  summary: z.string(),
  rationale: z.string().nullable(),
  concerns: z.string().nullable(),
});
export type Idea = z.infer<typeof IdeaSchema>;
export type IdeaField = "summary" | "rationale" | "concerns";
const IDEA_FIELDS: readonly ("rationale" | "concerns")[] = ["rationale", "concerns"];

/**
 * What the work acts on and how it behaves — the facts that decide whether
 * judgment is needed at all. The four enum fields are gaps while null; the
 * free-text ones are enrichment.
 *
 * - `inputs`           — what the workflow would act on, in the person's words
 * - `inputShape`       — structured (forms, tables, fields) | unstructured
 *                        (emails, documents, conversations) | mixed
 * - `rulesSpecifiable` — could the person write the handling rules down
 *                        completely, so they could be followed without
 *                        judgment: fully | mostly | partly | no
 * - `variability`      — how much the cases differ from one another
 * - `errorCost`        — what a wrong result costs: low (an annoyance) |
 *                        medium (rework, delay, money) | high (serious harm)
 * - `frequency`        — how often it runs / how many cases, in their words
 * - `auditability`     — whether each result must be explainable afterwards
 */
export const TASK_FIELD_VALUES = {
  inputShape: ["structured", "unstructured", "mixed"],
  rulesSpecifiable: ["fully", "mostly", "partly", "no"],
  variability: ["low", "medium", "high"],
  errorCost: ["low", "medium", "high"],
  auditability: ["required", "helpful", "not_needed"],
} as const;
export type TaskEnumField = keyof typeof TASK_FIELD_VALUES;
export const TASK_ENUM_FIELDS = Object.keys(TASK_FIELD_VALUES) as TaskEnumField[];
export type TaskTextField = "inputs" | "frequency";
export const TASK_TEXT_FIELDS: readonly TaskTextField[] = ["inputs", "frequency"];
export type TaskField = TaskEnumField | TaskTextField;
/** The task facts that are gaps while unknown — the ones that decide the approach. */
export const TASK_REQUIRED_FIELDS: readonly TaskEnumField[] = [
  "inputShape",
  "rulesSpecifiable",
  "variability",
  "errorCost",
];

export const TaskSchema = z.object({
  inputs: z.string().nullable(),
  inputShape: z.enum(TASK_FIELD_VALUES.inputShape).nullable(),
  rulesSpecifiable: z.enum(TASK_FIELD_VALUES.rulesSpecifiable).nullable(),
  variability: z.enum(TASK_FIELD_VALUES.variability).nullable(),
  errorCost: z.enum(TASK_FIELD_VALUES.errorCost).nullable(),
  frequency: z.string().nullable(),
  auditability: z.enum(TASK_FIELD_VALUES.auditability).nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * What the extraction LLM call produces: the brief and the graph, without
 * provenance. Provenance is stamped by deterministic code afterwards
 * ({@link stampOriginalProvenance}) — the model never writes provenance.
 */
export const ExtractionDraftSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  /** The problem or need the person is facing, in their terms. */
  problem: z.string().nullable(),
  /** The outcome they want — what success looks like. */
  goal: z.string().nullable(),
  /** Stated constraints (tools, people, time, rules). Optional enrichment. */
  constraints: z.array(z.string()),
  /** What the work acts on and how it behaves. */
  task: TaskSchema,
  /** Who the workflow is for. */
  profile: ProfileSchema,
  /** Approach-level ideas the person brought, with their reasoning. */
  ideas: z.array(IdeaSchema),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
});
export type ExtractionDraft = z.infer<typeof ExtractionDraftSchema>;

export type Provenance = "original" | "user_elicited" | "agent_proposed";

/** The full schema: the extraction draft plus per-field provenance. */
export interface Workflow extends ExtractionDraft {
  /**
   * Field path -> where the value came from. Only *filled* (non-null) fields
   * and existing entities have entries. Paths are produced exclusively by
   * {@link provenancePath} — never hand-build them.
   */
  provenance: Record<string, Provenance>;
}

/** The slice of a workflow the deterministic analyses operate on. */
export type WorkflowGraph = Pick<
  Workflow,
  "name" | "problem" | "goal" | "task" | "profile" | "ideas" | "nodes" | "edges"
>;

export type NodeField = "type" | "label" | "description" | "actor";
export type WorkflowField = "name" | "description" | "problem" | "goal";
export const WORKFLOW_FIELDS: readonly WorkflowField[] = ["name", "description", "problem", "goal"];
export type ProfileField = "technicalLevel" | "background";
export const PROFILE_FIELDS: readonly ProfileField[] = ["technicalLevel", "background"];

/** The key a tool is matched on: case- and whitespace-insensitive. */
export function toolKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Canonical provenance field paths.
 *
 * - `workflow.<field>`      — top-level name/description/problem/goal
 * - `constraint.<index>`    — one stated constraint
 * - `task.<field>`          — one task characteristic
 * - `profile.<field>`       — the person's technical level / background
 * - `profile.tool.<key>`    — one tool and its familiarity (see {@link toolKey})
 * - `profile.note.<index>`  — one profile note
 * - `idea.<id>`             — the idea's existence itself
 * - `idea.<id>.<field>`     — an idea's rationale or concerns
 * - `node.<id>`             — the node's existence itself
 * - `node.<id>.<field>`     — a node field
 * - `edge.<id>`             — the edge's existence itself
 * - `edge.<id>.label`       — an edge label
 */
export const provenancePath = {
  workflowField: (field: WorkflowField): string => `workflow.${field}`,
  constraint: (index: number): string => `constraint.${index}`,
  taskField: (field: TaskField): string => `task.${field}`,
  profileField: (field: ProfileField): string => `profile.${field}`,
  tool: (name: string): string => `profile.tool.${toolKey(name)}`,
  note: (index: number): string => `profile.note.${index}`,
  idea: (ideaId: string): string => `idea.${ideaId}`,
  ideaField: (ideaId: string, field: "rationale" | "concerns"): string => `idea.${ideaId}.${field}`,
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
  for (const field of WORKFLOW_FIELDS) {
    if (draft[field] !== null) provenance[provenancePath.workflowField(field)] = "original";
  }
  draft.constraints.forEach((_, i) => {
    provenance[provenancePath.constraint(i)] = "original";
  });
  for (const field of [...TASK_ENUM_FIELDS, ...TASK_TEXT_FIELDS]) {
    if (draft.task[field] !== null) provenance[provenancePath.taskField(field)] = "original";
  }
  for (const field of PROFILE_FIELDS) {
    if (draft.profile[field] !== null) provenance[provenancePath.profileField(field)] = "original";
  }
  for (const tool of draft.profile.tools) provenance[provenancePath.tool(tool.name)] = "original";
  draft.profile.notes.forEach((_, i) => {
    provenance[provenancePath.note(i)] = "original";
  });
  for (const idea of draft.ideas) {
    provenance[provenancePath.idea(idea.id)] = "original";
    for (const field of IDEA_FIELDS) {
      if (idea[field] !== null) provenance[provenancePath.ideaField(idea.id, field)] = "original";
    }
  }
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
  profile?: Profile;
  ideas?: Idea[];
}): string[] {
  const errors: string[] = [];
  const nodeIds = new Set<string>();

  const ideaIds = new Set<string>();
  for (const idea of draft.ideas ?? []) {
    if (idea.id.trim() === "") errors.push("an idea has an empty id");
    else if (ideaIds.has(idea.id)) errors.push(`duplicate idea id "${idea.id}"`);
    ideaIds.add(idea.id);
    if (idea.summary.trim() === "") errors.push(`idea "${idea.id}" has an empty summary`);
  }

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

  if (draft.profile) {
    const keys = new Set<string>();
    for (const tool of draft.profile.tools) {
      const key = toolKey(tool.name);
      if (key === "") errors.push("a tool has an empty name");
      else if (keys.has(key)) errors.push(`tool "${tool.name}" is listed twice`);
      keys.add(key);
    }
  }

  return errors;
}
