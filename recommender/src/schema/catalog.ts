/**
 * The pattern catalog schema. Patterns are DATA: growing the catalog means
 * appending literals to `../catalog/patterns.ts` — no code changes. The Zod
 * schema here is the contract that keeps that data honest (a test runs
 * {@link validateCatalog} over the real catalog).
 *
 * Applicability semantics
 * -----------------------
 * A pattern names the targets it applies to through two branches:
 *
 * - node branch:  `taskClasses` present → the pattern can target a single
 *   node whose class is in the list;
 * - motif branch: `motifs` present → the pattern can target a detected motif
 *   whose kind is in the list.
 *
 * A pattern with both branches matches EITHER kind of target ("RPA applies
 * to a manual transfer chain OR to a rule-based data-entry node"). Within a
 * branch, all present conditions must hold (AND); array conditions are
 * any-of.
 *
 * Ordinal gates compare through the score maps:
 * - `minStructure`  — structure score ≥ gate (at least this rule-like)
 * - `maxStructure`  — structure score ≤ gate (standardization patterns only
 *   make sense below a ceiling)
 * - `maxJudgment`   — judgment score ≥ gate. The judgment scale is inverted
 *   (higher = less judgment needed), so "at most `routine` judgment
 *   required" means score ≥ score(routine).
 * - `minFrequency`  — frequency score ≥ gate
 * - `minDuration` / `maxDuration` — duration score ≥ / ≤ gate
 * - `actorKinds`    — node's actorKind in the list. Node targets only:
 *   motif detectors already encode their own actor conditions.
 *
 * Unknown attribute values are substituted conservatively BEFORE gates are
 * evaluated (lowest ordinal; sensitivity → regulated), so a gate never
 * passes on a guess. See `../pipeline/match.ts`.
 *
 * Variants and the sensitivity hard filter
 * ----------------------------------------
 * Each pattern ships concrete variants (deployment options). A variant's
 * `sensitivityCeiling` is the most sensitive data it may touch; variants
 * whose ceiling is below the target's effective sensitivity are dropped
 * outright — a hard filter, not a score penalty. A pattern whose variants
 * are all dropped is reported under `excluded`, never silently omitted.
 *
 * `improves` and sequences
 * ------------------------
 * A pattern may declare that adopting it raises an attribute (v1: only
 * `structure`). When another pattern fails ONLY its `minStructure` gate on
 * a target, and an applicable pattern on that target raises structure to
 * the gate, the matcher emits an ordered two-step sequence ("first
 * standardize the input, then automate extraction").
 *
 * `advice` is the reserved slot for the future lessons-learned component:
 * stable pattern ids + this slot are its keying surface. Empty in v1.
 */
import { z } from "zod";
import {
  DurationSchema,
  FrequencySchema,
  JudgmentSchema,
  SensitivitySchema,
  StructureSchema,
  ActorKindSchema,
  TaskClassSchema,
} from "./taxonomy.js";
import { MotifKindSchema } from "./motif.js";

export const AUTOMATION_CLASSES = [
  "eliminate",
  "consolidate",
  "batch",
  "standardize",
  "rule_based_automation",
  "rpa",
  "delegate",
  "ai_assist",
  "ai_automate",
] as const;
export const AutomationClassSchema = z.enum(AUTOMATION_CLASSES);
export type AutomationClass = z.infer<typeof AutomationClassSchema>;

export const DEPLOYMENTS = ["external_saas", "internal_endpoint", "on_prem", "non_ai"] as const;
export const DeploymentSchema = z.enum(DEPLOYMENTS);
export type Deployment = z.infer<typeof DeploymentSchema>;

export const EFFORTS = ["low", "medium", "high"] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;
/** Multiplier applied to the constraint factor for the best surviving variant. */
export const EFFORT_FACTOR: Record<Effort, number> = {
  low: 1.0,
  medium: 0.85,
  high: 0.7,
};

export const ApplicabilitySchema = z.object({
  taskClasses: z.array(TaskClassSchema).min(1).optional(),
  motifs: z.array(MotifKindSchema).min(1).optional(),
  minStructure: StructureSchema.optional(),
  maxStructure: StructureSchema.optional(),
  maxJudgment: JudgmentSchema.optional(),
  minFrequency: FrequencySchema.optional(),
  minDuration: DurationSchema.optional(),
  maxDuration: DurationSchema.optional(),
  actorKinds: z.array(ActorKindSchema).min(1).optional(),
});
export type Applicability = z.infer<typeof ApplicabilitySchema>;

export const PatternVariantSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, "variant ids are snake_case"),
  name: z.string().min(1),
  description: z.string().min(1),
  deployment: DeploymentSchema,
  sensitivityCeiling: SensitivitySchema,
  effort: EffortSchema,
  prerequisites: z.array(z.string()),
  caveats: z.array(z.string()),
});
export type PatternVariant = z.infer<typeof PatternVariantSchema>;

export const FeasibilityWeightsSchema = z.object({
  /** Feasibility floor independent of structure/judgment (0..1). */
  base: z.number().min(0).max(1),
  /** Weight of the structure score's contribution (0..1). */
  structure: z.number().min(0).max(1),
  /** Weight of the judgment score's contribution (0..1). */
  judgment: z.number().min(0).max(1),
});
export type FeasibilityWeights = z.infer<typeof FeasibilityWeightsSchema>;

export const PatternDefSchema = z.object({
  /** Stable id, `pat.<snake>` — the lessons-learned keying surface. */
  id: z.string().regex(/^pat\.[a-z0-9_]+$/, 'pattern ids look like "pat.some_name"'),
  name: z.string().min(1),
  description: z.string().min(1),
  automationClass: AutomationClassSchema,
  applicability: ApplicabilitySchema,
  feasibilityWeights: FeasibilityWeightsSchema,
  improves: z
    .object({
      attribute: z.literal("structure"),
      raisesTo: StructureSchema,
    })
    .optional(),
  variants: z.array(PatternVariantSchema).min(1),
  /** Reserved for the lessons-learned component. Empty in v1. */
  advice: z.array(z.string()),
});
export type PatternDef = z.infer<typeof PatternDefSchema>;

/**
 * Validate a whole catalog: every entry parses, ids are unique (patterns
 * globally, variants within their pattern), and every pattern names at
 * least one target branch. Returns error strings; empty means valid.
 * Called from a test over the real catalog, and by loaders that accept
 * external catalog data.
 */
export function validateCatalog(patterns: unknown[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const [index, raw] of patterns.entries()) {
    const parsed = PatternDefSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`entry ${index}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      continue;
    }
    const pattern = parsed.data;
    if (ids.has(pattern.id)) errors.push(`duplicate pattern id "${pattern.id}"`);
    ids.add(pattern.id);

    if (!pattern.applicability.taskClasses && !pattern.applicability.motifs) {
      errors.push(`${pattern.id}: applicability names neither taskClasses nor motifs — the pattern can never match`);
    }

    const variantIds = new Set<string>();
    for (const variant of pattern.variants) {
      if (variantIds.has(variant.id)) {
        errors.push(`${pattern.id}: duplicate variant id "${variant.id}"`);
      }
      variantIds.add(variant.id);
    }
  }
  return errors;
}
