/**
 * Motifs — multi-node shapes in the workflow graph that carry improvement
 * signal a single node cannot: a chain of humans re-keying data between
 * systems, two approvals in a row, a verification loop that keeps sending
 * work back.
 *
 * Detection is entirely deterministic graph code over (nodes, edges,
 * profiles) — see `../pipeline/motifs.ts`. This module only defines the
 * vocabulary and the stable identity: like the preprocessor's `gapId`, a
 * motif's id is derived from its kind and sorted member ids, so the same
 * motif keeps the same id across runs — which is what lets the future
 * lessons-learned component and the `excluded` list refer to it stably.
 */
import { z } from "zod";

export const MOTIF_KINDS = [
  "manual_data_transfer_chain",
  "approval_chain",
  "notification_tail",
  "repeated_similar_tasks",
  "long_manual_chain",
  "rework_loop",
] as const;

export const MotifKindSchema = z.enum(MOTIF_KINDS);
export type MotifKind = z.infer<typeof MotifKindSchema>;

export interface Motif {
  /** Stable across runs: `motif.<kind>:<sorted node ids>`. */
  id: string;
  kind: MotifKind;
  /**
   * Member nodes. Path-ordered where the motif is a path (chains); sorted
   * otherwise. The id always uses the sorted form regardless.
   */
  nodeIds: string[];
  /** Edges inside the motif, where the shape has meaningful internal edges. */
  edgeIds: string[];
  /** One deterministic sentence describing what was detected, for reports. */
  evidence: string;
}

export function motifId(kind: MotifKind, nodeIds: string[]): string {
  return `motif.${kind}:${[...nodeIds].sort().join(",")}`;
}
