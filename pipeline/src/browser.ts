/**
 * The browser entry point — what `npm run build:browser` bundles into
 * `dist-browser/workflow-helper.js`.
 *
 * Same pipeline, same `runPipeline`. The one difference is where the LLM
 * client points: at a same-origin proxy on the website's backend, which
 * holds the API key and picks the model, rather than at the LLM endpoint
 * itself. Everything Node-only — files, stdin, the clipboard, the terminal
 * IO, `.env` loading, the CLI — is left out. `esbuild --platform=browser`
 * refuses any `node:` import, so a successful build proves nothing
 * Node-only leaked in.
 *
 * ```js
 * import { InternalLlmClient, inputFromBytes, runPipeline, textInput } from "./workflow-helper.js";
 *
 * const controller = new AbortController();
 * const llm = new InternalLlmClient({
 *   endpoint: "/api/workflow-helper/llm",   // the proxy; "/chat/completions" is appended
 *   model: "server-managed",                // required by the constructor; the proxy overrides it
 *   maxTokens, jsonMode,                    // from the proxy's config endpoint
 *   maxNetworkRetries: 1,
 *   retryableStatuses: [429, 502, 503],     // never retry the proxy's own 504
 *   timeoutMs: 150_000,                     // above the proxy's upstream timeout
 *   signal: controller.signal,
 *   fetchImpl: (url, init) => fetch(url, { ...init, credentials: "same-origin" }),
 * });
 * const result = await runPipeline(llm, textInput(description), { io, onProgress });
 * ```
 *
 * The proxy contract the client expects is implemented by
 * `examples/browser-proxy.ts` and written up in the README under
 * "Embedding in the browser".
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

// What the user is told when each stage's questions begin (terminal
// wording; a web UI keeps its own copy).
export { STAGE_BANNERS } from "./io/clarification.js";

// From the preprocessor: the LLM client and its errors, the inputs, and the
// types a UI needs to render questions and results.
export {
  InternalLlmClient,
  LlmHttpError,
  LlmRefusalError,
  LlmRepairExhaustedError,
  textInput,
  inputFromBytes,
  sniffImageMediaType,
  type InternalLlmClientOptions,
  type LlmClient,
  type InputPayload,
  type ImageMediaType,
  type BatchAnswers,
  type Question,
  type PreprocessResult,
  type Workflow,
  type WorkflowNode,
  type WorkflowEdge,
} from "workflow-preprocessor/core";

// From the recommender: the human label for an option token, and the
// question and result types.
export {
  displayToken,
  type ProfileQuestion,
  type RecommendationResult,
  type Opportunity,
} from "workflow-recommender";

// From the narrator: the report types.
export type { Narration, SummaryBlock, SummaryContent } from "workflow-narrator/core";
