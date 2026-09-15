/**
 * Public API of the workflow narrator.
 *
 * Typical library usage:
 *
 * ```ts
 * import { createLlmClient } from "workflow-preprocessor";
 * import { narrate, workflowFromPreprocessResult } from "workflow-narrator";
 *
 * const narration = await narrate(
 *   createLlmClient(), // reads LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL; or null for no model summary
 *   JSON.parse(readFileSync("re.recommendations.json", "utf8")),
 *   { workflow: workflowFromPreprocessResult(JSON.parse(readFileSync("re.json", "utf8"))) },
 * );
 * // narration.status is "complete" | "fallback" | "notice"; narration.report is Markdown
 * ```
 *
 * Everything browser-safe lives in `./core.ts` (also importable as
 * `workflow-narrator/core`); this module adds the Node-only file resolution.
 */
export * from "./core.js";

// Finding the sibling preprocessor result on disk (Node-only)
export {
  resolveWorkflow,
  siblingWorkflowPath,
  workflowFromPreprocessResult,
  RECOMMENDATIONS_SUFFIX,
  type ResolvedWorkflow,
  type ResolveWorkflowOptions,
} from "./io/workflow.js";
