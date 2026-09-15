/**
 * The browser-safe public API: everything `index.ts` exports except the
 * Node-only modules (file, stdin and clipboard loaders; the terminal
 * clarification IO; `.env` loading). Nothing reachable from here imports a
 * `node:` built-in, so a bundler targeting the browser can consume it —
 * `esbuild --platform=browser` refuses any `node:` import, which is the
 * guard that keeps this true.
 *
 * Importable as `workflow-preprocessor/core`. `workflow-preprocessor` (the
 * root) re-exports all of this plus the Node-only API, so Node callers are
 * unaffected.
 */

// Schema
export {
  NODE_TYPES,
  NodeTypeSchema,
  WorkflowNodeSchema,
  WorkflowEdgeSchema,
  ExtractionDraftSchema,
  provenancePath,
  stampOriginalProvenance,
  validateGraphIntegrity,
  type NodeType,
  type WorkflowNode,
  type WorkflowEdge,
  type ExtractionDraft,
  type Provenance,
  type Workflow,
  type WorkflowGraph,
} from "./schema/workflow.js";

export {
  PatchSchema,
  AnswerApplicationSchema,
  applyPatches,
  type Patch,
  type AnswerApplication,
  type PatchApplication,
} from "./schema/patches.js";

// Deterministic analyses
export { detectGaps, gapId, type Gap } from "./pipeline/gaps.js";
export {
  buildQuestions,
  DEFAULT_MAX_QUESTIONS_PER_ROUND,
  type Question,
} from "./pipeline/questions.js";

// LLM stages
export {
  triageInput,
  normalizeToIntermediate,
  extractDraft,
  TriageResultSchema,
  type TriageResult,
} from "./pipeline/stages.js";
export {
  applyAnswersWithLlm,
  type AnsweredQuestion,
  type ClarificationOutcome,
} from "./pipeline/clarify.js";

// Orchestration
export {
  runPreprocessor,
  DEFAULT_MAX_ROUNDS,
  type PreprocessorState,
  type PreprocessResult,
  type ClarificationIO,
  type BatchAnswers,
  type QARound,
  type RunOptions,
} from "./pipeline/run.js";

// LLM client
export {
  LlmRefusalError,
  LlmRepairExhaustedError,
  type LlmClient,
  type LlmContentPart,
  type StructuredCallOptions,
} from "./llm/client.js";
export {
  InternalLlmClient,
  LlmHttpError,
  type InternalLlmClientOptions,
} from "./llm/internalClient.js";
export {
  RoutingLlmClient,
  createLlmClient,
  type RoutingClients,
  type CreateLlmClientOptions,
} from "./llm/routingClient.js";
export { INTERMEDIATE_FORMAT } from "./llm/prompts.js";
export { probeLlm, PIXEL_PNG_BASE64, type ProbeOutcome } from "./llm/probe.js";

// Input payloads (pure: text, sniffing, bytes → payload)
export {
  inputFromBytes,
  sniffImageMediaType,
  textInput,
  type InputPayload,
  type ImageMediaType,
} from "./io/payload.js";

// Non-interactive clarification IO, and the minimal question shape any IO
// accepts ({ id, text }) so sibling components can drive it with their own
// questions.
export { silentIO, type AskableQuestion } from "./io/silent.js";
