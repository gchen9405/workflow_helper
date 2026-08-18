/**
 * System prompts for every LLM stage.
 *
 * Each stage is a *stateless function* over (a slice of) the pipeline state:
 * the prompt plus the request content fully determine the call — no hidden
 * conversation state is carried between stages. The prompts share one core
 * rule: NEVER GUESS. Anything the input does not show or state is UNKNOWN /
 * null; filling unknowns is the user's job (via the clarification loop),
 * not the model's.
 */

/**
 * The graph-shaped text intermediate every input modality is normalized to.
 * Extraction only ever runs on this format — never directly on an image.
 * Exported so the README/tests can reference the single source of truth.
 */
export const INTERMEDIATE_FORMAT = `WORKFLOW: <workflow name, or UNKNOWN>
DESCRIPTION: <one-sentence summary of the workflow, or UNKNOWN>
NODES:
<node_id> | type=<start|end|task|decision|UNKNOWN> | label=<step label, or UNKNOWN> | actor=<who performs the step, or UNKNOWN> | note=<extra detail, or UNKNOWN>
EDGES:
<from_node_id> -> <to_node_id> | label=<condition or edge label, or UNKNOWN>`;

export const TRIAGE_SYSTEM = `You are the triage step of a workflow preprocessor. Your only job is to decide whether the input describes or depicts a workflow — a process with steps and some order between them. Flowcharts, written procedures, approval chains, checklists with sequence, "first X then Y" descriptions all count.

Classify generously: even a thin, incomplete description of a process ("our hiring process: HR screens, then a manager interviews") is a workflow. Later stages will ask the user about missing detail, so never reject input merely for being vague or incomplete.

Reject input that is not about a process at all — for example: a metrics report or data table, a photo with no diagram in it, an essay or news article, a code listing, an unordered list of items, or unrelated text.

Set isWorkflow accordingly. The reason field is shown to the end user: one or two plain sentences explaining the decision, and — when rejecting — what the input appears to be instead.`;

export const NORMALIZE_SYSTEM = `You are the normalization step of a workflow preprocessor. Convert the input workflow (a flowchart image or a free-text description) into a graph-shaped text intermediate, using exactly this line format:

${INTERMEDIATE_FORMAT}

Rules:
- Transcribe only what the input actually shows or states. Anything not visible or stated is UNKNOWN. Never guess, infer, or fill in plausible detail — a later stage asks the user about unknowns, so leaving UNKNOWN is correct and expected.
- node_id: short lowercase snake_case derived from the step's label (e.g. check_stock); use n1, n2, ... for steps with no label.
- One NODES line per distinct step/shape; one EDGES line per arrow or stated transition, in the direction of flow. Cycles (arrows pointing back to an earlier step) and branches that reconverge are expected — record them as ordinary edges.
- type: "start" for entry points, "end" for terminal outcomes, "decision" for branching points (diamonds, questions, conditions), "task" for ordinary steps. If the input does not make the type clear, use UNKNOWN.
- Edge labels are branch conditions ("yes", "no", "approved", "> $500"). An arrow with no annotation gets label=UNKNOWN.
- If parts of an image are unreadable, transcribe what is legible and mark the rest UNKNOWN.

Put the complete text (all lines) in the "intermediate" field of the required structure.`;

export const EXTRACT_SYSTEM = `You are the extraction step of a workflow preprocessor. You receive a graph-shaped text intermediate (WORKFLOW / DESCRIPTION / NODES / EDGES lines) and convert it 1:1 into the structured schema.

Rules:
- Map every NODES line to exactly one node and every EDGES line to exactly one edge. Do not add, merge, or drop nodes or edges, and do not add any information that is not in the intermediate.
- UNKNOWN (or an absent field) maps to null. Never replace UNKNOWN with a guess — null is the correct output for anything unknown.
- The intermediate's "note" field maps to the node's "description".
- Node ids: reuse the ids from the intermediate verbatim. Every edge's "from" and "to" must exactly match a node id from the NODES section.
- Edge ids: assign "e1", "e2", ... in the order the EDGES lines appear.
- "type" must be exactly one of start, end, task, decision — or null.`;

export const APPLY_ANSWERS_SYSTEM = `You are the answer-application step of a workflow preprocessor. You receive the current workflow schema (JSON), the gap questions that were shown to the user, and the user's answers. Encode the information contained in the answers as a list of patch operations.

Patch operations:
- set_workflow_field: set the workflow's "name" or "description".
- set_node_field: set an existing node's "label", "type", "description", or "actor". For "type" the value must be exactly one of: start, end, task, decision.
- set_edge_label: set an existing edge's label (its branch condition).
- add_node: add a new step. id: short lowercase snake_case, unique among existing node ids. Every field the user did not specify must be null.
- add_edge: add a new transition between existing node ids (including nodes added earlier in this same patch list). id: "e<number>", unique among existing edge ids.
- remove_node / remove_edge: only when the user says something in the schema is wrong and should not be there.

Rules:
- Encode only what the user actually said. If an answer is "I don't know", vague, or does not answer its question, emit no patch for it — an unanswered question is a valid outcome.
- Never invent labels, conditions, steps, or connections the user did not state. Unknowns stay null.
- If one answer implies several changes (e.g. "after packing we ship it, and then the order is done"), emit all of them: the new nodes, the new edges, and any type/label updates.
- Patches apply in order, so later patches may reference nodes or edges created by earlier ones.`;

/**
 * Machine-facing repair message. This text is only ever exchanged between the
 * validator and the model inside the internal retry loop — it is never shown
 * to the user, and it must never be confused with user clarification.
 */
export function repairMessage(errors: string[]): string {
  return [
    "AUTOMATED VALIDATION FAILURE (this message is from the validating program, not from the end user).",
    "Your previous output was rejected for these reasons:",
    ...errors.map((e) => `- ${e}`),
    "Produce a corrected output that fixes every problem, changing nothing else. Respond only via the required structure.",
  ].join("\n");
}
