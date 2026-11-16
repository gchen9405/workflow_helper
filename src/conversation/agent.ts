/**
 * The two LLM calls behind a conversation turn. Each is a stateless function
 * over the session state (schema, open gaps, transcript) plus, for
 * interpretation, the person's latest message. Nothing is carried between
 * calls except through the state object.
 *
 *   interpretMessage  message -> { stated, accepted, finish }   (strict, dry-run validated)
 *   composeReply      state   -> next assistant message          (free-form)
 */
import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import { applyPatches, PatchSchema, type Patch } from "../schema/patches.js";
import type { Workflow } from "../schema/workflow.js";
import type { OpenGap } from "../graph/describe.js";
import type { GapScope } from "../graph/gaps.js";
import { INTERPRET_SYSTEM, respondSystem } from "./prompts.js";

/** One message in the conversation, as kept in the session state. */
export interface TranscriptMessage {
  role: "assistant" | "user";
  text: string;
  /**
   * User messages only: the patches interpretation derived from what the
   * person stated themselves, applied with provenance `user_elicited`.
   * Absent when interpretation itself failed.
   */
  patches?: Patch[];
  /**
   * User messages only: the assistant proposals the person accepted in this
   * message, applied (after `patches`) with provenance `agent_proposed`.
   */
  accepted?: Patch[];
}

/** The slice of session state both calls read. */
export interface AgentContext {
  scope: GapScope;
  workflow: Workflow;
  openGaps: OpenGap[];
  transcript: TranscriptMessage[];
}

const SCOPE_LINE: Record<GapScope, string> = {
  brief:
    "Scope of this conversation: BRIEF — understand the problem, the goal, the person and their ideas. The assistant makes no proposals; nothing is designed here.",
  design:
    "Scope of this conversation: DESIGN — build the workflow together; the assistant proposes steps the person accepts or adjusts.",
};

export const InterpretationSchema = z.object({
  /** What the person stated themselves. */
  stated: z.array(PatchSchema),
  /** Assistant proposals (from its last message) the person accepted. */
  accepted: z.array(PatchSchema),
  /** True when the person indicated they want to end the conversation. */
  finish: z.boolean(),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

export const ReplySchema = z.object({
  message: z.string(),
});

/**
 * Apply an interpretation: the person's own statements first, then the
 * proposals they accepted, each with its provenance. Returns the new
 * workflow and every validation error (empty when all patches applied).
 */
export function applyInterpretation(
  workflow: Workflow,
  interpretation: Pick<Interpretation, "stated" | "accepted">,
): { workflow: Workflow; errors: string[] } {
  const first = applyPatches(workflow, interpretation.stated, "user_elicited");
  const second = applyPatches(first.workflow, interpretation.accepted, "agent_proposed");
  return {
    workflow: second.workflow,
    errors: [
      ...first.errors.map((e) => `stated: ${e}`),
      ...second.errors.map((e) => `accepted: ${e}`),
    ],
  };
}

/** The model sees the schema, not the provenance bookkeeping. */
function bareSchema(workflow: Workflow): string {
  const { provenance: _provenance, ...bare } = workflow;
  return JSON.stringify(bare, null, 2);
}

function describePatch(patch: Patch): string {
  switch (patch.op) {
    case "set_workflow_field":
      return `set workflow ${patch.field} = ${JSON.stringify(patch.value)}`;
    case "add_constraint":
      return `added constraint ${JSON.stringify(patch.value)}`;
    case "set_task_field":
      return `set task ${patch.field} = ${JSON.stringify(patch.value)}`;
    case "set_technical_level":
      return `set technical level = ${patch.value}`;
    case "set_background":
      return `set background = ${JSON.stringify(patch.value)}`;
    case "set_tool_familiarity":
      return `noted tool ${JSON.stringify(patch.name)}: ${patch.familiarity}`;
    case "add_profile_note":
      return `noted about the person: ${JSON.stringify(patch.value)}`;
    case "add_idea":
      return `added idea ${patch.idea.id} (${JSON.stringify(patch.idea.summary)})`;
    case "set_idea_field":
      return `set idea ${patch.ideaId} ${patch.field} = ${JSON.stringify(patch.value)}`;
    case "remove_idea":
      return `removed idea ${patch.ideaId}`;
    case "set_node_field":
      return `set node ${patch.nodeId} ${patch.field} = ${JSON.stringify(patch.value)}`;
    case "set_edge_label":
      return `set edge ${patch.edgeId} label = ${JSON.stringify(patch.value)}`;
    case "add_node":
      return `added node ${patch.node.id}${patch.node.label ? ` (${JSON.stringify(patch.node.label)})` : ""}`;
    case "add_edge":
      return `added edge ${patch.edge.id} (${patch.edge.from} -> ${patch.edge.to})`;
    case "remove_node":
      return `removed node ${patch.nodeId}`;
    case "remove_edge":
      return `removed edge ${patch.edgeId}`;
  }
}

function describePatches(patches: Patch[]): string {
  return patches.length === 0 ? "nothing" : patches.map(describePatch).join("; ");
}

function renderTranscript(transcript: TranscriptMessage[]): string {
  if (transcript.length === 0) return "(no messages yet)";
  return transcript
    .map((m) => {
      const line = `${m.role === "assistant" ? "ASSISTANT" : "PERSON"}: ${m.text}`;
      if (m.role === "user" && m.patches !== undefined) {
        const accepted = m.accepted ?? [];
        const parts = [`from what they said: ${describePatches(m.patches)}`];
        if (accepted.length > 0) parts.push(`accepted proposals: ${describePatches(accepted)}`);
        if (m.patches.length === 0 && accepted.length === 0) {
          return `${line}\n  [applied to the schema: nothing — the message carried no usable information]`;
        }
        return `${line}\n  [applied to the schema — ${parts.join("; ")}]`;
      }
      return line;
    })
    .join("\n");
}

function renderGaps(openGaps: OpenGap[], scope: GapScope): string {
  if (openGaps.length === 0) {
    return scope === "brief" ? "(none — the brief is complete)" : "(none — the design is complete)";
  }
  return openGaps.map((g, i) => `${i + 1}. [${g.id}] ${g.description}`).join("\n");
}

/** The shared context block both calls start from. */
export function renderContext(context: AgentContext): string {
  return [
    SCOPE_LINE[context.scope],
    "",
    "Workflow schema captured so far (JSON):",
    bareSchema(context.workflow),
    "",
    "Open gaps (computed by code, in priority order):",
    renderGaps(context.openGaps, context.scope),
    "",
    "Conversation so far:",
    renderTranscript(context.transcript),
  ].join("\n");
}

/**
 * Interpret the person's latest message as patches against the current
 * schema. The semantic check dry-runs both lists in order, so an invalid
 * patch (unknown node id, duplicate id, bad node type) is repaired through
 * the machine-facing loop before it ever counts as this turn's result.
 */
export async function interpretMessage(
  llm: LlmClient,
  context: AgentContext,
  message: string,
): Promise<Interpretation> {
  return llm.structured({
    system: INTERPRET_SYSTEM,
    user: [
      {
        type: "text",
        text: `${renderContext(context)}\n\nLATEST message from the person (interpret this one):\n${message}`,
      },
    ],
    schema: InterpretationSchema,
    taskLabel: "message interpretation",
    semanticCheck: (value) => applyInterpretation(context.workflow, value).errors,
  });
}

/**
 * Compose the assistant's next message from the current state. For the
 * opening message the transcript is empty; otherwise its last entry is the
 * person's latest message, annotated with what was applied from it.
 */
export async function composeReply(llm: LlmClient, context: AgentContext): Promise<string> {
  const task =
    context.transcript.length === 0
      ? "Write the opening message."
      : "Write the assistant's next message.";
  const result = await llm.structured({
    system: respondSystem(context.scope),
    user: [{ type: "text", text: `${renderContext(context)}\n\n${task}` }],
    schema: ReplySchema,
    taskLabel: "reply composition",
    semanticCheck: (value) =>
      value.message.trim() === "" ? ["the message is empty"] : [],
  });
  return result.message.trim();
}
