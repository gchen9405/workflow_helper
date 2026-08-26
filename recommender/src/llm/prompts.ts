/**
 * System prompt for the recommender's single LLM stage: profiling.
 *
 * The stage is a stateless function over its inputs (workflow context + a
 * chunk of nodes), and the prompt carries the same core rule as every
 * preprocessor stage: NEVER GUESS. A value the node text does not state or
 * strongly imply stays null; filling unknowns is the user's job via the
 * clarification loop, not the model's.
 *
 * The taxonomy and scale documentation is generated from
 * `../schema/taxonomy.ts` so the prompt can never drift from the enums the
 * output schema enforces.
 */
import {
  ACTOR_KINDS,
  DURATIONS,
  ERROR_PRONENESS,
  FREQUENCIES,
  JUDGMENTS,
  SENSITIVITIES,
  STRUCTURES,
  TASK_CLASSES,
  TASK_CLASS_DEFINITIONS,
} from "../schema/taxonomy.js";

const taxonomyLines = TASK_CLASSES.map(
  (c) => `- ${c}: ${TASK_CLASS_DEFINITIONS[c]}`,
).join("\n");

const list = (values: readonly string[]): string => values.join(" | ");

export const PROFILE_SYSTEM = `You are the profiling step of a workflow automation recommender. You receive a workflow's name/description and a list of its steps (id, label, description, actor). For EACH requested step, produce one profile: a task classification plus attribute estimates.

Task classes (choose the single best fit; use "other" only when nothing fits):
${taxonomyLines}

Attributes and their closed scales:
- frequency: ${list(FREQUENCIES)} — how often the step is performed
- duration: ${list(DURATIONS)} — how long one run takes
- structure: ${list(STRUCTURES)} — how completely the step could be written as explicit rules
- judgment: ${list(JUDGMENTS)} — the level of human judgment the step REQUIRES ("none" = a machine could decide)
- dataSensitivity: ${list(SENSITIVITIES)} — the most sensitive data the step touches
- actorKind: ${list(ACTOR_KINDS)} — who performs the step today ("ai_agent" when an AI agent or LLM does the work)
- errorProneness: ${list(ERROR_PRONENESS)} — how often the step goes wrong today

Every value is reported as { value, basis, evidence }:
- basis "explicit": the step's text states it outright ("daily", "the compliance team", "an AI agent drafts…"). evidence quotes the wording.
- basis "implied": a defensible reading of the wording (an actor named "SAP" implies actorKind system; "patient records" implies dataSensitivity regulated). evidence names the wording and the reading.
- Anything the text neither states nor strongly implies: value null, basis null, evidence null. NEVER GUESS — a later step asks the user, so null is correct and expected. Most attributes of most steps are null; that is normal. Do not infer frequency, duration, structure, judgment, or sensitivity from what steps "like this" are usually like — only from what THIS input actually says.
- taskClass is your classification job, so a value is expected for nearly every step (basis "implied" is normal there; evidence explains the reading). Use "other" rather than forcing a bad fit.

Output exactly one profile per requested step id — no extra ids, none missing.`;
