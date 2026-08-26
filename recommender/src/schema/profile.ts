/**
 * Node profiles — what the single LLM stage produces and the clarification
 * loop completes.
 *
 * Every classified/estimated value is wrapped in an {@link AttrValue}:
 *
 *   { value, basis, evidence }
 *
 * with the LLM-output invariant (enforced as a semanticCheck, so violations
 * go through the machine repair loop, never to the user):
 *
 *   value !== null  ⇔  basis !== null AND evidence is a non-empty string
 *
 * `basis` records HOW the model knew: `"explicit"` — the node text states it
 * outright; `"implied"` — a defensible reading of the wording. Deterministic
 * stamping maps that onto the component's provenance vocabulary:
 *
 *   explicit → "original"      (grounded in the input)
 *   implied  → "inferred"      (the model's estimate)
 *   answer   → "user_elicited" (set later by the clarification loop, which
 *               clears basis/evidence — the invariant above binds only
 *               LLM output, not user-answered profiles)
 *
 * This extends the preprocessor's `original | user_elicited` provenance with
 * `inferred`, and it is exactly what recommendation confidence keys off.
 * The recommender's provenance map is its own flat map under `profile.*`
 * keys (built only by {@link profilePath}); the preprocessor's map is echoed
 * in the result untouched.
 */
import { z } from "zod";
import {
  ActorKindSchema,
  DurationSchema,
  ErrorPronenessSchema,
  FrequencySchema,
  JudgmentSchema,
  SensitivitySchema,
  StructureSchema,
  TaskClassSchema,
  type ActorKind,
  type Duration,
  type ErrorProneness,
  type Frequency,
  type Judgment,
  type Sensitivity,
  type Structure,
  type TaskClass,
} from "./taxonomy.js";

export const BASES = ["explicit", "implied"] as const;
export const BasisSchema = z.enum(BASES);
export type Basis = z.infer<typeof BasisSchema>;

/** A classified/estimated value plus how the model knew it. */
export interface AttrValue<E> {
  value: E | null;
  basis: Basis | null;
  evidence: string | null;
}

function attrValue<T extends z.ZodType>(valueSchema: T) {
  return z.object({
    value: valueSchema.nullable(),
    basis: BasisSchema.nullable(),
    evidence: z.string().nullable(),
  });
}

/** The attributes every profile carries. `errorProneness` is optional enrichment. */
export const ATTRIBUTE_NAMES = [
  "frequency",
  "duration",
  "structure",
  "judgment",
  "dataSensitivity",
  "actorKind",
  "errorProneness",
] as const;
export type AttributeName = (typeof ATTRIBUTE_NAMES)[number];

/** The attributes gap detection requires (errorProneness is never a gap). */
export const REQUIRED_ATTRIBUTES = [
  "frequency",
  "duration",
  "structure",
  "judgment",
  "dataSensitivity",
  "actorKind",
] as const;
export type RequiredAttribute = (typeof REQUIRED_ATTRIBUTES)[number];

export const NodeProfileSchema = z.object({
  nodeId: z.string(),
  taskClass: attrValue(TaskClassSchema),
  attributes: z.object({
    frequency: attrValue(FrequencySchema),
    duration: attrValue(DurationSchema),
    structure: attrValue(StructureSchema),
    judgment: attrValue(JudgmentSchema),
    dataSensitivity: attrValue(SensitivitySchema),
    actorKind: attrValue(ActorKindSchema),
    errorProneness: attrValue(ErrorPronenessSchema),
  }),
});

export interface NodeProfile {
  nodeId: string;
  taskClass: AttrValue<TaskClass>;
  attributes: {
    frequency: AttrValue<Frequency>;
    duration: AttrValue<Duration>;
    structure: AttrValue<Structure>;
    judgment: AttrValue<Judgment>;
    dataSensitivity: AttrValue<Sensitivity>;
    actorKind: AttrValue<ActorKind>;
    errorProneness: AttrValue<ErrorProneness>;
  };
}

/** What the LLM emits: profiles only. It never writes provenance. */
export const ProfileDraftSchema = z.object({
  profiles: z.array(NodeProfileSchema),
});
export type ProfileDraft = z.infer<typeof ProfileDraftSchema>;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type RecommenderProvenance = "original" | "inferred" | "user_elicited";

/**
 * Canonical provenance field paths for profile values. Never hand-build
 * these strings — mirror of the preprocessor's `provenancePath` discipline.
 *
 * - `profile.<nodeId>.class`        — the task classification
 * - `profile.<nodeId>.attr.<name>`  — one attribute
 */
export const profilePath = {
  taskClass: (nodeId: string): string => `profile.${nodeId}.class`,
  attr: (nodeId: string, name: AttributeName): string => `profile.${nodeId}.attr.${name}`,
};

/**
 * Stamp provenance for freshly profiled nodes: every filled value gets an
 * entry derived from its basis. Deterministic; no LLM involved.
 */
export function stampProfileProvenance(
  profiles: NodeProfile[],
): Record<string, RecommenderProvenance> {
  const provenance: Record<string, RecommenderProvenance> = {};
  const fromBasis = (basis: Basis | null): RecommenderProvenance =>
    basis === "explicit" ? "original" : "inferred";
  for (const profile of profiles) {
    if (profile.taskClass.value !== null) {
      provenance[profilePath.taskClass(profile.nodeId)] = fromBasis(profile.taskClass.basis);
    }
    for (const name of ATTRIBUTE_NAMES) {
      const attr = profile.attributes[name];
      if (attr.value !== null) {
        provenance[profilePath.attr(profile.nodeId, name)] = fromBasis(attr.basis);
      }
    }
  }
  return provenance;
}

/**
 * The LLM-output invariant plus id discipline, as repair-loop error strings.
 * `expectedNodeIds` are the ids the call asked the model to profile.
 */
export function checkProfileDraft(draft: ProfileDraft, expectedNodeIds: string[]): string[] {
  const errors: string[] = [];
  const expected = new Set(expectedNodeIds);
  const seen = new Set<string>();

  for (const profile of draft.profiles) {
    if (!expected.has(profile.nodeId)) {
      errors.push(`profile for unknown node id "${profile.nodeId}" — profile exactly the requested nodes`);
      continue;
    }
    if (seen.has(profile.nodeId)) {
      errors.push(`duplicate profile for node "${profile.nodeId}"`);
      continue;
    }
    seen.add(profile.nodeId);

    const checkValue = (label: string, attr: AttrValue<unknown>): void => {
      if (attr.value !== null) {
        if (attr.basis === null) {
          errors.push(`${label} of "${profile.nodeId}" has a value but no basis — set basis to "explicit" or "implied"`);
        }
        if (attr.evidence === null || attr.evidence.trim() === "") {
          errors.push(`${label} of "${profile.nodeId}" has a value but no evidence — quote or paraphrase the wording that supports it`);
        }
      } else {
        if (attr.basis !== null || (attr.evidence !== null && attr.evidence.trim() !== "")) {
          errors.push(`${label} of "${profile.nodeId}" is null but carries basis/evidence — an unknown value must have basis: null and evidence: null`);
        }
      }
    };

    checkValue("taskClass", profile.taskClass);
    for (const name of ATTRIBUTE_NAMES) {
      checkValue(`attribute "${name}"`, profile.attributes[name]);
    }
  }

  for (const id of expectedNodeIds) {
    if (!seen.has(id)) errors.push(`missing profile for node "${id}"`);
  }
  return errors;
}
