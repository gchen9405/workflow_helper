/**
 * The conversation: a back-and-forth between the person and the agent that
 * designs the workflow — understanding the problem and goal first, then
 * building the steps together — until the design is complete or the person
 * stops.
 *
 * State is one plain-JSON object ({@link SessionState}) and every operation
 * is a pure function over it: `openConversation` and `sendMessage` return a
 * NEW state and never mutate their input. A host that holds the state
 * between HTTP requests can serialize it as it is; a host whose LLM call
 * fails mid-turn still has the previous state intact.
 *
 * What stays deterministic, and why it still matters here:
 *
 *   - gap detection (`../graph/gaps.ts`) is run by code after every turn and
 *     is the agent's authoritative to-do list — the agent decides how to ask,
 *     never what counts as complete;
 *   - patches are the only way a message changes the schema, dry-run
 *     validated inside the interpretation call and applied by code with
 *     provenance stamping (`../schema/patches.ts`): what the person stated
 *     is `user_elicited`, an assistant proposal they accepted is
 *     `agent_proposed`;
 *   - termination is unconditional: the person can end at any time, the
 *     interpretation call can flag that they asked to, and `maxTurns` caps
 *     the number of person messages.
 *
 * A turn costs two model calls (interpret, then respond). A message the
 * model cannot interpret costs one and produces a fixed nudge instead of a
 * composed reply; a reply the model cannot compose ends the conversation,
 * keeping everything applied so far.
 */
import {
  LlmRefusalError,
  LlmRepairExhaustedError,
  type LlmClient,
} from "../llm/client.js";
import type { Workflow } from "../schema/workflow.js";
import { listOpenGaps, type OpenGap } from "../graph/describe.js";
import type { GapScope } from "../graph/gaps.js";
import {
  applyInterpretation,
  composeReply,
  interpretMessage,
  type Interpretation,
  type TranscriptMessage,
} from "./agent.js";

export type { TranscriptMessage } from "./agent.js";

/** Why a conversation ended. */
export type ConversationEnd =
  /** The person said they were done (detected by interpretation). */
  | { by: "user" }
  /** The host closed it (a Finish button, /done, end of input). */
  | { by: "host" }
  /** The person-message cap was reached. */
  | { by: "turn_limit"; maxTurns: number }
  /** The model declined or could not produce a usable reply. */
  | { by: "model_failure"; message: string };

export interface SessionState {
  /** What this conversation is for — which gaps count (see `../graph/gaps.ts`). */
  scope: GapScope;
  /** The schema as of the latest applied message. */
  workflow: Workflow;
  /** What the schema still lacks, in priority order. Empty = complete. */
  openGaps: OpenGap[];
  /** Every message so far, oldest first. The last one is the agent's unless the conversation just ended. */
  transcript: TranscriptMessage[];
  /** Person messages consumed so far. */
  turns: number;
  status: "open" | "closed";
  /** Set exactly when `status` is "closed". */
  end?: ConversationEnd;
}

export interface ConversationOptions {
  /** Cap on person messages. Guarantees termination. Default 40. */
  maxTurns?: number;
}

export const DEFAULT_MAX_TURNS = 40;
/** The one scope in use today: understand, don't design. */
export const DEFAULT_SCOPE: GapScope = "brief";

/** What the agent says when it could not make sense of a message. */
export const UNINTERPRETABLE_NUDGE =
  "I couldn't quite work out what to take from that — could you put it another way?";

function isLlmFailure(err: unknown): err is LlmRefusalError | LlmRepairExhaustedError {
  return err instanceof LlmRefusalError || err instanceof LlmRepairExhaustedError;
}

function closed(state: SessionState, end: ConversationEnd): SessionState {
  return { ...state, status: "closed", end };
}

/**
 * Start a conversation about `workflow` in `scope` (default "brief"): the
 * agent composes its opening message from the schema and its open gaps. The returned state is open,
 * with that message as the transcript's only entry — unless the model could
 * not produce one, in which case the state is already closed (model_failure)
 * and the schema is returned as it came in.
 */
export async function openConversation(
  llm: LlmClient,
  workflow: Workflow,
  scope: GapScope = DEFAULT_SCOPE,
): Promise<SessionState> {
  const state: SessionState = {
    scope,
    workflow: structuredClone(workflow),
    openGaps: listOpenGaps(workflow, scope),
    transcript: [],
    turns: 0,
    status: "open",
  };
  let opening: string;
  try {
    opening = await composeReply(llm, state);
  } catch (err) {
    if (isLlmFailure(err)) return closed(state, { by: "model_failure", message: err.message });
    throw err;
  }
  return { ...state, transcript: [{ role: "assistant", text: opening }] };
}

/**
 * One turn: interpret the person's message, apply what it established,
 * recompute the gaps, then either compose the agent's next message or end
 * the conversation. Returns the new state; the input state is untouched.
 *
 * Throws on a closed conversation or an empty message (host errors), and
 * propagates transport failures (the host retries with the same state).
 */
export async function sendMessage(
  llm: LlmClient,
  state: SessionState,
  message: string,
  options: ConversationOptions = {},
): Promise<SessionState> {
  if (state.status !== "open") throw new Error("the conversation is closed");
  const text = message.trim();
  if (text === "") throw new Error("the message is empty");
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  // 1. Interpret: message -> patches (dry-run validated inside the call).
  let interpretation: Interpretation | undefined;
  try {
    interpretation = await interpretMessage(llm, state, text);
  } catch (err) {
    if (!isLlmFailure(err)) throw err;
    // Not interpretable: keep the message, apply nothing, nudge below.
  }

  // 2. Apply by code, with provenance stamping; recompute the gaps.
  const workflow = interpretation
    ? applyInterpretation(state.workflow, interpretation).workflow
    : state.workflow;
  const finish = interpretation?.finish ?? false;
  const userMessage: TranscriptMessage = interpretation
    ? { role: "user", text, patches: interpretation.stated, accepted: interpretation.accepted }
    : { role: "user", text };
  let next: SessionState = {
    ...state,
    workflow,
    openGaps: listOpenGaps(workflow, state.scope),
    transcript: [...state.transcript, userMessage],
    turns: state.turns + 1,
  };

  // 3. End, or respond.
  if (finish) return closed(next, { by: "user" });
  if (next.turns >= maxTurns) return closed(next, { by: "turn_limit", maxTurns });

  if (interpretation === undefined) {
    return {
      ...next,
      transcript: [...next.transcript, { role: "assistant", text: UNINTERPRETABLE_NUDGE }],
    };
  }

  let reply: string;
  try {
    reply = await composeReply(llm, next);
  } catch (err) {
    if (isLlmFailure(err)) return closed(next, { by: "model_failure", message: err.message });
    throw err;
  }
  next = { ...next, transcript: [...next.transcript, { role: "assistant", text: reply }] };
  return next;
}

/** End the conversation from the host's side. A no-op on a closed state. */
export function closeConversation(state: SessionState): SessionState {
  return state.status === "closed" ? state : closed(state, { by: "host" });
}

/** The agent's most recent message, or null before the first one. */
export function lastAssistantMessage(state: SessionState): string | null {
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    if (state.transcript[i].role === "assistant") return state.transcript[i].text;
  }
  return null;
}

/**
 * Convenience wrapper over the pure functions for hosts that keep the
 * session in memory: holds the current state and the client.
 *
 * ```ts
 * const conversation = await Conversation.open(llm, workflow);
 * show(conversation.lastMessage);
 * while (conversation.isOpen) {
 *   const reply = await conversation.send(await readLine());
 *   if (reply !== null) show(reply);
 * }
 * conversation.state // -> feed to resultFromConversation()
 * ```
 */
export class Conversation {
  private current: SessionState;

  private constructor(
    private readonly llm: LlmClient,
    state: SessionState,
    private readonly options: ConversationOptions,
  ) {
    this.current = state;
  }

  static async open(
    llm: LlmClient,
    workflow: Workflow,
    options: ConversationOptions & { scope?: GapScope } = {},
  ): Promise<Conversation> {
    return new Conversation(llm, await openConversation(llm, workflow, options.scope), options);
  }

  /** Continue from a stored state (a web session, say). */
  static resume(
    llm: LlmClient,
    state: SessionState,
    options: ConversationOptions = {},
  ): Conversation {
    return new Conversation(llm, state, options);
  }

  get state(): SessionState {
    return this.current;
  }

  get isOpen(): boolean {
    return this.current.status === "open";
  }

  /** The agent's latest message (what to show the person next). */
  get lastMessage(): string | null {
    return lastAssistantMessage(this.current);
  }

  /**
   * Send the person's message. Resolves to the agent's reply, or null when
   * the conversation ended on this turn (see `state.end` for why).
   */
  async send(message: string): Promise<string | null> {
    const before = this.current.transcript.length;
    this.current = await sendMessage(this.llm, this.current, message, this.options);
    const added = this.current.transcript.slice(before);
    const reply = added.find((m) => m.role === "assistant");
    return reply ? reply.text : null;
  }

  close(): void {
    this.current = closeConversation(this.current);
  }
}
