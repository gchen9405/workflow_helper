/**
 * The browser-safe public API: everything `index.ts` exports except the
 * Node-only modules (file, stdin and clipboard loaders; the terminal
 * conversation; `.env` loading). Nothing reachable from here imports a
 * `node:` built-in, so a bundler targeting the browser can consume it —
 * `esbuild --platform=browser` refuses any `node:` import, which is the
 * guard that keeps this true.
 *
 * Importable as `workflow-helper/core`. `workflow-helper` (the root)
 * re-exports all of this plus the Node-only API, so Node callers are
 * unaffected.
 */

// Schema
export {
  NODE_TYPES,
  WORKFLOW_FIELDS,
  PROFILE_FIELDS,
  TECHNICAL_LEVELS,
  TOOL_FAMILIARITIES,
  NodeTypeSchema,
  TechnicalLevelSchema,
  ToolFamiliaritySchema,
  ToolSchema,
  ProfileSchema,
  IdeaSchema,
  TaskSchema,
  TASK_FIELD_VALUES,
  TASK_REQUIRED_FIELDS,
  toolKey,
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
  type WorkflowField,
  type ProfileField,
  type Profile,
  type Tool,
  type TechnicalLevel,
  type ToolFamiliarity,
  type Idea,
  type IdeaField,
  type Task,
  type TaskField,
  type TaskEnumField,
} from "./schema/workflow.js";

export {
  PatchSchema,
  applyPatches,
  type Patch,
  type PatchApplication,
} from "./schema/patches.js";

// Deterministic analyses
export { detectGaps, gapId, type Gap, type GapScope } from "./graph/gaps.js";
export {
  describeGap,
  listOpenGaps,
  GAP_PRIORITY,
  type OpenGap,
} from "./graph/describe.js";

// Intake stages
export {
  triageInput,
  normalizeToIntermediate,
  extractDraft,
  TriageResultSchema,
  type TriageResult,
} from "./extract/stages.js";
export { INTERMEDIATE_FORMAT } from "./extract/prompts.js";

// The conversation
export {
  Conversation,
  openConversation,
  sendMessage,
  closeConversation,
  lastAssistantMessage,
  DEFAULT_MAX_TURNS,
  DEFAULT_SCOPE,
  UNINTERPRETABLE_NUDGE,
  type SessionState,
  type ConversationEnd,
  type ConversationOptions,
  type TranscriptMessage,
} from "./conversation/session.js";
export {
  interpretMessage,
  composeReply,
  applyInterpretation,
  InterpretationSchema,
  ReplySchema,
  type Interpretation,
  type AgentContext,
} from "./conversation/agent.js";

// Orchestration
export {
  runSession,
  intake,
  resultFromIntake,
  resultFromConversation,
  type SessionResult,
  type Intake,
  type ConversationIO,
  type SessionOptions,
} from "./run.js";

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
export { probeLlm, PIXEL_PNG_BASE64, type ProbeOutcome } from "./llm/probe.js";

// Input payloads (pure: text, sniffing, bytes → payload)
export {
  inputFromBytes,
  sniffImageMediaType,
  textInput,
  type InputPayload,
  type ImageMediaType,
} from "./io/payload.js";
