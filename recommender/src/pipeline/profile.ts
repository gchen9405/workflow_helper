/**
 * THE ONLY LLM STAGE in the recommender: classify each task/decision node
 * into the closed taxonomy and propose attribute estimates.
 *
 * Everything before this is loading/validation; everything after —
 * provenance, gaps, questions, answers, motifs, matching, scoring — is
 * deterministic code. The model emits a PROPOSAL (`ProfileDraftSchema`);
 * it never writes provenance and never mutates state.
 *
 * Nodes are profiled in deterministic chunks of at most
 * {@link MAX_NODES_PER_CALL} so one oversized workflow cannot blow the
 * output token budget of a single call. Each chunk call is stateless and
 * carries the workflow name/description as context; structural validity
 * (ids exactly matching the request, the value⇔basis/evidence invariant)
 * is enforced via `semanticCheck`, so violations go through the injected
 * client's machine repair loop — never to the user.
 */
import type { LlmClient, WorkflowNode } from "workflow-preprocessor";
import {
  ProfileDraftSchema,
  checkProfileDraft,
  type NodeProfile,
} from "../schema/profile.js";
import { PROFILE_SYSTEM } from "../llm/prompts.js";

export const MAX_NODES_PER_CALL = 12;

export interface WorkflowContext {
  name: string | null;
  description: string | null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function describeNodes(nodes: WorkflowNode[]): string {
  return nodes
    .map((n) =>
      [
        `- id: ${n.id}`,
        `  label: ${n.label ?? "UNKNOWN"}`,
        `  description: ${n.description ?? "UNKNOWN"}`,
        `  actor: ${n.actor ?? "UNKNOWN"}`,
      ].join("\n"),
    )
    .join("\n");
}

/**
 * Profile the given nodes. Returns one profile per node, in the order the
 * nodes were given. Throws the client's `LlmRefusalError` /
 * `LlmRepairExhaustedError` upward — the orchestrator maps those to the
 * `unsuitable` terminal state (no profile exists yet, same logic as the
 * preprocessor's pre-schema failures).
 */
export async function profileNodes(
  llm: LlmClient,
  context: WorkflowContext,
  nodes: WorkflowNode[],
): Promise<NodeProfile[]> {
  const profiles = new Map<string, NodeProfile>();

  for (const nodeChunk of chunk(nodes, MAX_NODES_PER_CALL)) {
    const ids = nodeChunk.map((n) => n.id);
    const user = [
      `Workflow: ${context.name ?? "UNKNOWN"}`,
      `Description: ${context.description ?? "UNKNOWN"}`,
      "",
      `Profile these ${ids.length} step(s):`,
      describeNodes(nodeChunk),
    ].join("\n");

    const draft = await llm.structured({
      system: PROFILE_SYSTEM,
      user: [{ type: "text", text: user }],
      schema: ProfileDraftSchema,
      taskLabel: "profiling",
      semanticCheck: (value) => checkProfileDraft(value, ids),
    });

    for (const profile of draft.profiles) {
      profiles.set(profile.nodeId, profile);
    }
  }

  // semanticCheck guarantees per-chunk completeness, so this lookup is total.
  return nodes.map((n) => profiles.get(n.id)!);
}
