/**
 * Public API of the workflow preprocessor.
 *
 * Typical library usage:
 *
 * ```ts
 * import {
 *   InternalLlmClient,
 *   runPreprocessor,
 *   textInput,
 *   type ClarificationIO,
 * } from "workflow-preprocessor";
 *
 * const io: ClarificationIO = { async askBatch(questions) { ... } };
 * const result = await runPreprocessor(
 *   new InternalLlmClient(), // reads LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL
 *   textInput("A new order comes in, then ..."),
 *   io,
 * );
 * // result.status is "validated" | "partial" | "rejected"
 * ```
 *
 * Everything browser-safe lives in `./core.ts` (also importable as
 * `workflow-preprocessor/core`); this module adds the Node-only pieces.
 */
export * from "./core.js";

// Input loading from files, folders, stdin and the clipboard (Node-only)
export {
  discoverInputs,
  isDirectory,
  loadInputFromBuffer,
  loadInputFromClipboard,
  loadInputFromFile,
  loadInputFromStdin,
  normalizeInputPath,
  readStream,
  resolveInputPath,
  type DiscoverOptions,
  type LoadFileOptions,
} from "./io/input.js";

export {
  readClipboard,
  type ClipboardContent,
  type ClipboardDeps,
  type ClipboardRunner,
} from "./io/clipboard.js";

// Interactive clarification IO (terminal). `silentIO` and `AskableQuestion`
// come from ./core.
export { ReadlineClarificationIO, openClarificationIO } from "./io/clarification.js";

// Configuration
export {
  findEnvFile,
  loadEnvFile,
  parseEnvFile,
  type EnvFileLoad,
} from "./io/env.js";
