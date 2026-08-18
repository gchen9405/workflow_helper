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

// Input handling
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
  sniffImageMediaType,
  textInput,
  type DiscoverOptions,
  type InputPayload,
  type ImageMediaType,
  type LoadFileOptions,
} from "./io/input.js";

export {
  readClipboard,
  type ClipboardContent,
  type ClipboardDeps,
  type ClipboardRunner,
} from "./io/clipboard.js";

// Configuration
export {
  findEnvFile,
  loadEnvFile,
  parseEnvFile,
  type EnvFileLoad,
} from "./io/env.js";
export { probeLlm, PIXEL_PNG_BASE64, type ProbeOutcome } from "./llm/probe.js";
