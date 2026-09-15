/**
 * Public API of the workflow pipeline — the end-to-end entry point.
 *
 * ```ts
 * import { createLlmClient, runPipeline, textInput } from "workflow-pipeline";
 *
 * const result = await runPipeline(
 *   createLlmClient(),                 // reads LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL
 *   textInput("A new order comes in, then …"),
 *   // { io } to ask clarifying questions; omitted → none asked, thin input → partial
 * );
 * result.status;          // "complete" | "fallback" | "notice"
 * result.report;          // the narrator's Markdown report
 * result.preprocess;      // the schema (+ open questions), for a UI that shows more
 * result.recommendation;  // the ranked opportunities
 * ```
 *
 * Everything a host (a CLI, a web backend) needs to drive a run is
 * re-exported here, so embedding means importing one package: the LLM
 * client factory, the input constructors, the terminal IO, env loading, the
 * probe, and the error classes worth matching on.
 */

// Orchestration
export {
  runPipeline,
  isChoiceQuestion,
  PipelineStageError,
  DEFAULT_INPUT_LABEL,
  type PipelineStage,
  type ClarificationStage,
  type PipelineQuestion,
  type PipelineClarificationIO,
  type PipelineProgress,
  type PipelineRunOptions,
  type PipelineResult,
} from "./pipeline/run.js";

// Terminal IO
export { stagedIO, STAGE_BANNERS, type SimpleClarificationIO } from "./io/clarification.js";

// From the preprocessor: the LLM client, inputs, terminal IO, configuration
export {
  createLlmClient,
  InternalLlmClient,
  RoutingLlmClient,
  LlmHttpError,
  LlmRefusalError,
  LlmRepairExhaustedError,
  textInput,
  inputFromBytes,
  loadInputFromBuffer,
  loadInputFromFile,
  loadInputFromStdin,
  loadInputFromClipboard,
  normalizeInputPath,
  sniffImageMediaType,
  silentIO,
  openClarificationIO,
  ReadlineClarificationIO,
  loadEnvFile,
  findEnvFile,
  probeLlm,
  type LlmClient,
  type CreateLlmClientOptions,
  type InputPayload,
  type ImageMediaType,
  type BatchAnswers,
  type AskableQuestion,
  type PreprocessResult,
  type Workflow,
  type WorkflowNode,
  type WorkflowEdge,
  type Question,
  type ProbeOutcome,
} from "workflow-preprocessor";

// From the recommender: the result and question types a UI renders
export {
  STARTER_CATALOG,
  type RecommendationResult,
  type Opportunity,
  type ProfileQuestion,
  type PatternDef,
} from "workflow-recommender";

// From the narrator: the report types
export type { Narration, SummaryBlock, SummaryContent } from "workflow-narrator";
