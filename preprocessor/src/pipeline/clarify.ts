/**
 * User-facing clarification: turn a round of answered questions into schema
 * patches and apply them.
 *
 * The single LLM call here is a stateless function over
 * (current schema, questions, answers) -> patches. It does not mutate
 * anything itself: patch application, validation, and provenance stamping
 * are the deterministic code in `../schema/patches.ts`.
 *
 * The `semanticCheck` dry-runs the patches against the current workflow, so
 * an invalid patch list (unknown node id, duplicate id, bad node type) is
 * repaired through the internal machine-facing loop before it ever counts as
 * this round's result.
 */
import type { LlmClient } from "../llm/client.js";
import { APPLY_ANSWERS_SYSTEM } from "../llm/prompts.js";
import {
  AnswerApplicationSchema,
  applyPatches,
  type Patch,
} from "../schema/patches.js";
import type { Workflow } from "../schema/workflow.js";
import type { Question } from "./questions.js";

export interface AnsweredQuestion {
  question: Question;
  /** The user's verbatim answer (non-empty; skipped questions are filtered out upstream). */
  answer: string;
}

export interface ClarificationOutcome {
  /** The workflow with this round's patches applied and provenance stamped. */
  workflow: Workflow;
  /** The patches the model emitted (all valid — guaranteed by the repair loop). */
  patches: Patch[];
  /** How many patches applied. 0 means the answers carried no usable information. */
  appliedCount: number;
}

export async function applyAnswersWithLlm(
  llm: LlmClient,
  workflow: Workflow,
  answered: AnsweredQuestion[],
): Promise<ClarificationOutcome> {
  // The model sees the graph, not the provenance bookkeeping.
  const bareSchema = {
    name: workflow.name,
    description: workflow.description,
    nodes: workflow.nodes,
    edges: workflow.edges,
  };

  const qaText = answered
    .map(
      (a, i) =>
        `Q${i + 1} [${a.question.id}]: ${a.question.text}\nA${i + 1}: ${a.answer}`,
    )
    .join("\n\n");

  const result = await llm.structured({
    system: APPLY_ANSWERS_SYSTEM,
    user: [
      {
        type: "text",
        text: `Current workflow schema:\n${JSON.stringify(bareSchema, null, 2)}\n\nQuestions shown to the user, and the user's answers:\n\n${qaText}`,
      },
    ],
    schema: AnswerApplicationSchema,
    taskLabel: "answer application",
    // Dry-run: any rejected patch becomes a repair error.
    semanticCheck: (value) => applyPatches(workflow, value.patches).errors,
  });

  const application = applyPatches(workflow, result.patches);
  return {
    workflow: application.workflow,
    patches: result.patches,
    appliedCount: application.appliedCount,
  };
}
