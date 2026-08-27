/**
 * Finding the step names. The recommender's result refers to steps by node
 * id and quotes labels only inside its templated explanations; a readable
 * report wants the labels everywhere, and the flow order and branch labels
 * come from the graph. All of that lives in the PREPROCESSOR result the
 * recommender consumed, so the narrator looks for it — without ever
 * requiring it (ids are a perfectly honest fallback).
 *
 * Resolution order:
 *   1. `--workflow <file>` — explicit; a missing or unreadable file, or one
 *      that does not contain the profiled steps, is an error, because the
 *      user asked for that file specifically;
 *   2. `source.path` recorded in the recommender result;
 *   3. the sibling convention: `<stem>.recommendations.json` sits next to
 *      the `<stem>.json` it was produced from.
 * Auto-discovered candidates are accepted only when they parse as a
 * non-rejected preprocessor result AND cover every profiled node id — a
 * different workflow that happens to share a name is discarded, not used.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadPreprocessResult } from "workflow-recommender";
import type { Workflow } from "workflow-preprocessor";

export const RECOMMENDATIONS_SUFFIX = ".recommendations.json";

export interface ResolvedWorkflow {
  workflow: Workflow;
  path: string;
}

/** Turn preprocessor result JSON into a workflow, or null when it was rejected. */
export function workflowFromPreprocessResult(json: unknown): Workflow | null {
  const loaded = loadPreprocessResult(json);
  return loaded.status === "rejected" ? null : loaded.workflow;
}

/** The `<stem>.json` a `<stem>.recommendations.json` was produced from. */
export function siblingWorkflowPath(inputPath: string): string | null {
  const name = basename(inputPath);
  if (!name.endsWith(RECOMMENDATIONS_SUFFIX)) return null;
  const stem = name.slice(0, -RECOMMENDATIONS_SUFFIX.length);
  return join(dirname(inputPath), `${stem}.json`);
}

function readWorkflowFile(path: string): Workflow | null {
  const json: unknown = JSON.parse(readFileSync(path, "utf8"));
  return workflowFromPreprocessResult(json);
}

function covers(workflow: Workflow, nodeIds: readonly string[]): boolean {
  const ids = new Set(workflow.nodes.map((n) => n.id));
  return nodeIds.every((id) => ids.has(id));
}

export interface ResolveWorkflowOptions {
  /** `--workflow`: must exist and load, else an Error is thrown. */
  explicitPath?: string;
  /** The recommender result file, for the sibling convention. */
  inputPath?: string;
  /** `source.path` from the recommender result. */
  sourcePath?: string;
  /**
   * Node ids the workflow must contain: an auto-discovered candidate that
   * lacks any is skipped; an explicit file that lacks any is an error.
   */
  requiredNodeIds?: readonly string[];
}

/**
 * Resolve the preprocessor result that names the steps. Returns null when
 * nothing usable was found — never throws for auto-discovered candidates.
 */
export function resolveWorkflow(options: ResolveWorkflowOptions): ResolvedWorkflow | null {
  if (options.explicitPath !== undefined) {
    const path = resolve(options.explicitPath);
    if (!existsSync(path)) throw new Error(`workflow file not found: ${path}`);
    let workflow: Workflow | null;
    try {
      workflow = readWorkflowFile(path);
    } catch (err) {
      throw new Error(
        `could not read the workflow file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (workflow === null) {
      throw new Error(`the workflow file ${path} is a rejected preprocessor result — it has no steps`);
    }
    if (options.requiredNodeIds && !covers(workflow, options.requiredNodeIds)) {
      const ids = new Set(workflow.nodes.map((n) => n.id));
      const missing = options.requiredNodeIds.filter((id) => !ids.has(id));
      throw new Error(
        `the workflow file ${path} is not the one this result was produced from — it has no steps ${missing.map((id) => `"${id}"`).join(", ")}`,
      );
    }
    return { workflow, path };
  }

  const candidates: string[] = [];
  if (options.sourcePath) candidates.push(resolve(options.sourcePath));
  if (options.inputPath) {
    const sibling = siblingWorkflowPath(resolve(options.inputPath));
    if (sibling) candidates.push(sibling);
  }

  for (const path of [...new Set(candidates)]) {
    if (!existsSync(path)) continue;
    try {
      const workflow = readWorkflowFile(path);
      if (workflow === null) continue;
      if (options.requiredNodeIds && !covers(workflow, options.requiredNodeIds)) continue;
      return { workflow, path };
    } catch {
      // Not a preprocessor result (or unreadable): try the next candidate.
    }
  }
  return null;
}
