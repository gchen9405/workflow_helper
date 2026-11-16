/**
 * The orchestrator. Wires intake to the conversation and enforces the
 * terminal-state guarantee:
 *
 *   EVERY input terminates in exactly one of three states —
 *     1. `validated` — complete for the conversation's scope (zero gaps):
 *                      today, a complete BRIEF — the problem, goal, person
 *                      and ideas are understood;
 *     2. `partial`   — a brief with explicitly listed open gaps;
 *     3. `rejected`  — a graceful rejection with a stated reason.
 *   Never a confident-looking brief from garbage input.
 *
 * How each exit is reached:
 *
 *   rejected:
 *     - triage says the input is not something a workflow could be designed
 *       for (reason from triage);
 *     - an intake stage (triage/normalize/extract) hits a safety refusal or
 *       exhausts the internal repair loop — we refuse to fabricate a brief
 *       we could not derive.
 *   validated:
 *     - `detectGaps()` (deterministic, unit-tested code) returns empty when
 *       the conversation ends. Never straight from intake: the deciding
 *       task facts are cleared there (see `withoutDecidingFacts`), so a
 *       brief only validates once the person has answered for them.
 *   partial:
 *     - gaps remain when the conversation ends — because the person said
 *       they were done, the host closed it, the turn cap was hit, or the
 *       model could not continue — or no conversation was possible.
 *
 * Termination argument: intake is three bounded calls; the conversation
 * ends when the person or host says so, and `maxTurns` makes it finite
 * regardless of what the model or the person does.
 *
 * Two entry points. `runSession` does everything behind one
 * {@link ConversationIO} seam, which is what a terminal or a scripted test
 * implements. A request/response host (a website) instead calls `intake`
 * once, drives the conversation itself with the pure functions in
 * `./conversation/session.ts` across requests, and finishes with
 * `resultFromConversation`.
 */
import {
  LlmRefusalError,
  LlmRepairExhaustedError,
  type LlmClient,
} from "./llm/client.js";
import type { InputPayload } from "./io/payload.js";
import {
  stampOriginalProvenance,
  TASK_REQUIRED_FIELDS,
  type ExtractionDraft,
  type Workflow,
} from "./schema/workflow.js";
import { listOpenGaps, type OpenGap } from "./graph/describe.js";
import type { GapScope } from "./graph/gaps.js";
import {
  closeConversation,
  DEFAULT_SCOPE,
  lastAssistantMessage,
  openConversation,
  sendMessage,
  type ConversationEnd,
  type SessionState,
  type TranscriptMessage,
} from "./conversation/session.js";
import {
  extractDraft,
  normalizeToIntermediate,
  triageInput,
} from "./extract/stages.js";

export type SessionResult =
  | {
      status: "validated";
      schema: Workflow;
      intermediate: string;
      /** The whole conversation, oldest first. Empty when none was held. */
      transcript: TranscriptMessage[];
    }
  | {
      status: "partial";
      schema: Workflow;
      /** Everything still unknown, in priority order, traceable to its gap. */
      openGaps: OpenGap[];
      reason: string;
      intermediate: string;
      transcript: TranscriptMessage[];
    }
  | { status: "rejected"; reason: string };

/** What intake alone produces, before any conversation. */
export type Intake =
  | { status: "accepted"; workflow: Workflow; intermediate: string }
  | { status: "rejected"; reason: string };

/**
 * How `designWorkflow` talks to the person. The CLI implements this over
 * readline; a test harness scripts it. The orchestrator never touches
 * stdin/stdout itself.
 */
export interface ConversationIO {
  /**
   * Show the agent's message and wait for the person's reply. Resolve to
   * null when the person ends the conversation from the host's side (a
   * Finish button, `/done`, end of input). An empty reply is asked again.
   */
  reply(message: string, state: SessionState): Promise<string | null>;
}

export interface SessionOptions {
  /** The conversation channel. Absent: no conversation; the input comes back as extracted. */
  io?: ConversationIO;
  /** Cap on person messages per conversation. Guarantees termination. Default 40. */
  maxTurns?: number;
  /**
   * What the conversation is for. "brief" (the default, and the only scope
   * the pipeline uses today): understand the problem, goal, person and
   * ideas; never design. "design": build the whole workflow — reserved for
   * the conversation that follows resource selection.
   */
  scope?: GapScope;
}

function isLlmFailure(err: unknown): err is LlmRefusalError | LlmRepairExhaustedError {
  return err instanceof LlmRefusalError || err instanceof LlmRepairExhaustedError;
}

/**
 * The deciding task facts are the conversation's to fill, never intake's:
 * whatever the model inferred for them is cleared before provenance is
 * stamped, so each is a gap the person is asked about (or asked to confirm)
 * and none is ever labeled `original`. The prompts already say not to infer
 * them; this makes it a guarantee. The inference stays visible in the
 * intermediate text.
 */
function withoutDecidingFacts(draft: ExtractionDraft): ExtractionDraft {
  const task = { ...draft.task };
  for (const field of TASK_REQUIRED_FIELDS) task[field] = null;
  return { ...draft, task };
}

/**
 * Intake — stages 1–3: triage, normalize, extract. A rejection here is
 * final; an accepted input yields the brief and whatever workflow the person
 * already had in mind, which is where the conversation starts.
 */
export async function intake(llm: LlmClient, input: InputPayload): Promise<Intake> {
  // ---- Stage 1: triage (reject what no workflow could address) ---------------
  let triage;
  try {
    triage = await triageInput(llm, input);
  } catch (err) {
    if (isLlmFailure(err)) return { status: "rejected", reason: err.message };
    throw err;
  }
  if (!triage.isWorkflow) {
    return {
      status: "rejected",
      reason: `the input does not describe a problem or process a workflow could address: ${triage.reason}`,
    };
  }

  // ---- Stages 2 + 3: normalize to the intermediate, then extract -------------
  try {
    const intermediate = await normalizeToIntermediate(llm, input);
    const draft = withoutDecidingFacts(await extractDraft(llm, intermediate));
    return { status: "accepted", workflow: stampOriginalProvenance(draft), intermediate };
  } catch (err) {
    // No schema exists yet, so failure here is a graceful rejection — we
    // never fabricate a brief we could not actually derive.
    if (isLlmFailure(err)) {
      return {
        status: "rejected",
        reason: `could not derive a usable brief from the input (${err.message})`,
      };
    }
    throw err;
  }
}

function endReason(end: ConversationEnd | undefined): string {
  switch (end?.by) {
    case "user":
      return "the person ended the conversation with gaps still open";
    case "host":
      return "the conversation was closed with gaps still open";
    case "turn_limit":
      return `the conversation turn limit (${end.maxTurns}) was reached with gaps still open`;
    case "model_failure":
      return `the assistant could not continue the conversation (${end.message})`;
    case undefined:
      return "the conversation is still open";
  }
}

/**
 * The terminal state for a workflow with no conversation held about it.
 * `reason` says why none was held (shown in the partial result).
 */
export function resultFromIntake(
  workflow: Workflow,
  intermediate: string,
  reason = "no conversation was held",
  scope: GapScope = DEFAULT_SCOPE,
): SessionResult {
  const openGaps = listOpenGaps(workflow, scope);
  if (openGaps.length === 0) {
    return { status: "validated", schema: workflow, intermediate, transcript: [] };
  }
  return { status: "partial", schema: workflow, openGaps, reason, intermediate, transcript: [] };
}

/**
 * The terminal state at the end of a conversation. An open state is closed
 * first (as if by the host), so the result is always final.
 */
export function resultFromConversation(state: SessionState, intermediate: string): SessionResult {
  const final = closeConversation(state);
  if (final.openGaps.length === 0) {
    return {
      status: "validated",
      schema: final.workflow,
      intermediate,
      transcript: final.transcript,
    };
  }
  return {
    status: "partial",
    schema: final.workflow,
    openGaps: final.openGaps,
    reason: endReason(final.end),
    intermediate,
    transcript: final.transcript,
  };
}

/**
 * Everything in one call: intake, then the conversation over `io` until it
 * ends, and the terminal state. The conversation is always opened when a
 * channel is given — even a fully specified input is worth a review with the
 * person — and skipped when none is.
 */
export async function runSession(
  llm: LlmClient,
  input: InputPayload,
  options: SessionOptions = {},
): Promise<SessionResult> {
  const accepted = await intake(llm, input);
  if (accepted.status === "rejected") return accepted;
  const { workflow, intermediate } = accepted;
  const scope = options.scope ?? DEFAULT_SCOPE;

  const io = options.io;
  if (!io) return resultFromIntake(workflow, intermediate, undefined, scope);

  // ---- The conversation: open, then alternate until it ends -----------------
  const loop = { maxTurns: options.maxTurns };
  let state = await openConversation(llm, workflow, scope);
  while (state.status === "open") {
    const message = lastAssistantMessage(state);
    if (message === null) break; // cannot happen on an open state; defensive
    const reply = await io.reply(message, state);
    if (reply === null) {
      state = closeConversation(state);
      break;
    }
    if (reply.trim() === "") continue;
    state = await sendMessage(llm, state, reply, loop);
  }
  return resultFromConversation(state, intermediate);
}
