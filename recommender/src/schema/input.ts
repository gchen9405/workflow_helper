/**
 * The input boundary: validating a preprocessor result JSON into a typed
 * value the pipeline can trust.
 *
 * The preprocessor exports TypeScript types for `PreprocessResult` but no
 * runtime Zod schema for the envelope, so the envelope is validated locally.
 * Node and edge objects, however, are validated through the preprocessor's
 * OWN `WorkflowNodeSchema` / `WorkflowEdgeSchema` — the two packages each
 * carry their own zod instance, so cross-package schemas are only ever used
 * at `.parse()` call boundaries here, never embedded inside this package's
 * `z.object()` trees.
 *
 * Inherited open questions are kept as `{ id, text, gap: unknown }`: the
 * recommender only echoes them and reads node ids out of `gap` defensively
 * (see `readGapNodeIds`) — it never depends on the preprocessor's Gap union.
 */
import { z } from "zod";
import {
  WorkflowEdgeSchema,
  WorkflowNodeSchema,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "workflow-preprocessor";

/** An inherited preprocessor question, kept structurally minimal. */
export interface InheritedQuestion {
  id: string;
  text: string;
  gap: unknown;
}

const InheritedQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  gap: z.unknown(),
});

const WorkflowEnvelopeSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
  provenance: z.record(z.string(), z.enum(["original", "user_elicited"])),
});

const PreprocessEnvelopeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("validated"), schema: WorkflowEnvelopeSchema }),
  z.object({
    status: z.literal("partial"),
    schema: WorkflowEnvelopeSchema,
    openQuestions: z.array(InheritedQuestionSchema),
    reason: z.string(),
  }),
  z.object({ status: z.literal("rejected"), reason: z.string() }),
]);

export type LoadedPreprocessResult =
  | {
      status: "validated" | "partial";
      workflow: Workflow;
      openQuestions: InheritedQuestion[];
    }
  | { status: "rejected"; reason: string };

/**
 * Validate parsed JSON into a typed preprocessor result. Throws an Error
 * with a readable message when the value is not a preprocessor result —
 * the CLI maps that to exit code 1 (a usage problem, not a terminal state).
 */
export function loadPreprocessResult(json: unknown): LoadedPreprocessResult {
  const envelope = PreprocessEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new Error(
      "not a preprocessor result JSON (expected status validated/partial/rejected " +
        "with a workflow schema) — generate one with workflow-preprocessor first",
    );
  }
  const result = envelope.data;
  if (result.status === "rejected") {
    return { status: "rejected", reason: result.reason };
  }

  const nodes: WorkflowNode[] = [];
  for (const [i, raw] of result.schema.nodes.entries()) {
    const parsed = WorkflowNodeSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`node ${i} in the input schema is malformed`);
    nodes.push(parsed.data);
  }
  const edges: WorkflowEdge[] = [];
  for (const [i, raw] of result.schema.edges.entries()) {
    const parsed = WorkflowEdgeSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`edge ${i} in the input schema is malformed`);
    edges.push(parsed.data);
  }

  const workflow: Workflow = {
    name: result.schema.name,
    description: result.schema.description,
    nodes,
    edges,
    provenance: result.schema.provenance,
  };
  return {
    status: result.status,
    workflow,
    openQuestions: result.status === "partial" ? result.openQuestions : [],
  };
}

/**
 * Best-effort extraction of the node ids an inherited gap talks about.
 * Reads `nodeId` / `nodeIds` defensively off the unknown gap object; an
 * unrecognized shape yields [] rather than an error.
 */
export function readGapNodeIds(gap: unknown): string[] {
  if (typeof gap !== "object" || gap === null) return [];
  const record = gap as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof record.nodeId === "string") ids.push(record.nodeId);
  if (Array.isArray(record.nodeIds)) {
    for (const id of record.nodeIds) {
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}
