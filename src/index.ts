/**
 * Public API of workflow-helper.
 *
 * Typical library usage — everything in one call, with your own
 * conversation channel:
 *
 * ```ts
 * import { createLlmClient, runSession, textInput, type ConversationIO } from "workflow-helper";
 *
 * const io: ConversationIO = {
 *   async reply(message) { show(message); return await readLine(); } // null = finish
 * };
 * const result = await runSession(createLlmClient(), textInput("We keep losing track of …"), { io });
 * // result.status is "validated" | "partial" | "rejected"
 * ```
 *
 * Or, for a request/response host, step by step with plain-JSON state:
 *
 * ```ts
 * const accepted = await intake(llm, input);                     // once
 * let state = await openConversation(llm, accepted.workflow);    // -> opening message
 * state = await sendMessage(llm, state, personsReply);           // per request
 * const result = resultFromConversation(state, accepted.intermediate);
 * ```
 *
 * Everything browser-safe lives in `./core.ts` (also importable as
 * `workflow-helper/core`); this module adds the Node-only pieces.
 */
export * from "./core.js";

// Input loading from files and stdin (Node-only)
export {
  loadInputFromBuffer,
  loadInputFromFile,
  loadInputFromStdin,
  normalizeInputPath,
  readStream,
  resolveInputPath,
  type LoadFileOptions,
} from "./io/input.js";

// The terminal conversation
export {
  TerminalConversationIO,
  openTerminalConversation,
  END_COMMANDS,
} from "./io/terminal.js";

// Configuration
export {
  findEnvFile,
  loadEnvFile,
  parseEnvFile,
  type EnvFileLoad,
} from "./io/env.js";
