/**
 * Catalog matching — deterministic evaluation of every (pattern, target)
 * pair, plus sequence composition and the sensitivity hard filter.
 *
 * Targets are single nodes (with their profiles) and detected motifs (with
 * attributes AGGREGATED from their members: frequency/duration/sensitivity
 * take the worst-case max, structure/judgment the weakest-link min — and an
 * aggregate is null whenever a member's value is unknown in a direction
 * that could hide risk, so the conservative substitution below still
 * applies).
 *
 * UNKNOWN VALUES NEVER FLATTER A RECOMMENDATION. Before gates or scores see
 * an attribute, {@link effectiveValues} substitutes conservatively — every
 * unknown ordinal takes its LOWEST score, unknown sensitivity becomes
 * `regulated` — and each substitution is recorded as a human-readable
 * reason that ends up in the opportunity's `confidenceReasons`. A gate can
 * therefore fail on a substituted value (that is intended: "we don't know
 * that this is rule-based" must not match a pattern requiring it), and a
 * sequence can repair exactly that (see below).
 *
 * THE SENSITIVITY HARD FILTER: variants whose `sensitivityCeiling` is below
 * the target's effective sensitivity are dropped, not down-scored. A
 * matching pattern that loses every variant is reported in `excluded` with
 * the reason — never silently omitted.
 *
 * SEQUENCES: when pattern P fails ONLY its `minStructure` gate on a target,
 * and some directly applicable pattern Q on the same target declares
 * `improves.structure` reaching P's gate, the ordered sequence [Q, P] is
 * emitted ("first standardize the input, then automate extraction"),
 * scored with the post-improvement structure (see score.ts). v1: sequences
 * have length 2 and `improves` only raises structure.
 */
import type { Motif, MotifKind } from "../schema/motif.js";
import type { NodeProfile } from "../schema/profile.js";
import type { Effort, PatternDef } from "../schema/catalog.js";
import type {
  ExcludedOpportunity,
  OpportunityTarget,
  SequenceStep,
  SurvivingVariant,
} from "../schema/result.js";
import {
  DURATION_SCORE,
  ERROR_BONUS,
  FREQUENCY_SCORE,
  JUDGMENT_SCORE,
  SENSITIVITY_SCORE,
  STRUCTURE_SCORE,
  type ActorKind,
  type Duration,
  type ErrorProneness,
  type Frequency,
  type Judgment,
  type Sensitivity,
  type Structure,
  type TaskClass,
} from "../schema/taxonomy.js";

/** Attribute values as known (null = unknown); the substitution layer's input. */
export interface KnownAttributes {
  frequency: Frequency | null;
  duration: Duration | null;
  structure: Structure | null;
  judgment: Judgment | null;
  dataSensitivity: Sensitivity | null;
  actorKind: ActorKind | null;
  errorProneness: ErrorProneness | null;
}

export interface CandidateTarget {
  target: OpportunityTarget;
  /** Set for node targets. */
  taskClass: TaskClass | null;
  /** Set for motif targets. */
  motifKind: MotifKind | null;
  attrs: KnownAttributes;
  /** All nodes involved (one for node targets) — the affectedBy surface. */
  nodeIds: string[];
}

/** Post-substitution values every gate and score runs on. */
export interface EffectiveValues {
  frequencyScore: number;
  durationScore: number;
  structureScore: number;
  judgmentScore: number;
  sensitivity: Sensitivity;
  errorBonus: number;
  /** One entry per conservative substitution — feeds confidenceReasons. */
  substitutions: string[];
}

export function effectiveValues(attrs: KnownAttributes): EffectiveValues {
  const substitutions: string[] = [];
  const ordinal = <T extends string>(
    value: T | null,
    scores: Record<T, number>,
    name: string,
    lowestLabel: string,
  ): number => {
    if (value !== null) return scores[value];
    substitutions.push(`${name} unknown — scored at the lowest value (${lowestLabel})`);
    return 1;
  };

  const frequencyScore = ordinal(attrs.frequency, FREQUENCY_SCORE, "frequency", "ad hoc");
  const durationScore = ordinal(attrs.duration, DURATION_SCORE, "duration", "under 5 minutes");
  const structureScore = ordinal(attrs.structure, STRUCTURE_SCORE, "structure", "case by case");
  const judgmentScore = ordinal(attrs.judgment, JUDGMENT_SCORE, "judgment", "expert");

  let sensitivity: Sensitivity;
  if (attrs.dataSensitivity !== null) {
    sensitivity = attrs.dataSensitivity;
  } else {
    sensitivity = "regulated";
    substitutions.push("data sensitivity unknown — treated as regulated (worst case)");
  }

  const errorBonus = attrs.errorProneness !== null ? ERROR_BONUS[attrs.errorProneness] : 0;

  return { frequencyScore, durationScore, structureScore, judgmentScore, sensitivity, errorBonus, substitutions };
}

// ---------------------------------------------------------------------------
// Candidate construction
// ---------------------------------------------------------------------------

function knownAttributes(profile: NodeProfile): KnownAttributes {
  const a = profile.attributes;
  return {
    frequency: a.frequency.value,
    duration: a.duration.value,
    structure: a.structure.value,
    judgment: a.judgment.value,
    dataSensitivity: a.dataSensitivity.value,
    actorKind: a.actorKind.value,
    errorProneness: a.errorProneness.value,
  };
}

/**
 * Aggregate member attributes for a motif target. Each rule is exactly
 * "substitute conservatively per member, then aggregate", expressed so the
 * substitution layer still fires (and records its reason) on the aggregate:
 * - max-direction scales where unknown substitutes LOW (frequency,
 *   duration): unknown members cannot raise a max — aggregate over known;
 * - min-direction scales where unknown substitutes LOW (structure,
 *   judgment): one unknown member makes the min unknown — aggregate null;
 * - max-direction where unknown substitutes HIGH (sensitivity): one
 *   unknown member makes the max unknown — aggregate null.
 */
function aggregateAttributes(motif: Motif, byNode: Map<string, NodeProfile>): KnownAttributes {
  const members = motif.nodeIds
    .map((id) => byNode.get(id))
    .filter((p): p is NodeProfile => p !== undefined)
    .map(knownAttributes);

  const maxOfKnown = <T extends string>(
    values: (T | null)[],
    scores: Record<T, number>,
  ): T | null => {
    const known = values.filter((v): v is T => v !== null);
    if (known.length === 0) return null;
    return known.reduce((best, v) => (scores[v] > scores[best] ? v : best));
  };
  const minUnlessUnknown = <T extends string>(
    values: (T | null)[],
    scores: Record<T, number>,
  ): T | null => {
    if (values.some((v) => v === null)) return null;
    const known = values as T[];
    return known.reduce((worst, v) => (scores[v] < scores[worst] ? v : worst));
  };
  const maxUnlessUnknown = <T extends string>(
    values: (T | null)[],
    scores: Record<T, number>,
  ): T | null => {
    if (values.some((v) => v === null)) return null;
    const known = values as T[];
    return known.reduce((worst, v) => (scores[v] > scores[worst] ? v : worst));
  };

  return {
    frequency: maxOfKnown(members.map((m) => m.frequency), FREQUENCY_SCORE),
    duration: maxOfKnown(members.map((m) => m.duration), DURATION_SCORE),
    structure: minUnlessUnknown(members.map((m) => m.structure), STRUCTURE_SCORE),
    judgment: minUnlessUnknown(members.map((m) => m.judgment), JUDGMENT_SCORE),
    dataSensitivity: maxUnlessUnknown(members.map((m) => m.dataSensitivity), SENSITIVITY_SCORE),
    actorKind: null, // motif detectors already encode their actor conditions
    errorProneness: maxOfKnown(members.map((m) => m.errorProneness), ERROR_BONUS),
  };
}

export function buildCandidates(profiles: NodeProfile[], motifs: Motif[]): CandidateTarget[] {
  const byNode = new Map(profiles.map((p) => [p.nodeId, p]));
  const nodeCandidates: CandidateTarget[] = profiles.map((profile) => ({
    target: { kind: "node", nodeId: profile.nodeId },
    taskClass: profile.taskClass.value,
    motifKind: null,
    attrs: knownAttributes(profile),
    nodeIds: [profile.nodeId],
  }));
  const motifCandidates: CandidateTarget[] = motifs.map((motif) => ({
    target: { kind: "motif", motifId: motif.id },
    taskClass: null,
    motifKind: motif.kind,
    attrs: aggregateAttributes(motif, byNode),
    nodeIds: [...motif.nodeIds],
  }));
  return [...nodeCandidates, ...motifCandidates];
}

// ---------------------------------------------------------------------------
// Applicability
// ---------------------------------------------------------------------------

type Gate =
  | "target"
  | "minStructure"
  | "maxStructure"
  | "maxJudgment"
  | "minFrequency"
  | "minDuration"
  | "maxDuration"
  | "actorKinds";

/** Which gates fail for this (pattern, candidate) pair. Empty = applicable. */
function failedGates(pattern: PatternDef, candidate: CandidateTarget, values: EffectiveValues): Gate[] {
  const app = pattern.applicability;
  const failed: Gate[] = [];

  if (candidate.target.kind === "node") {
    if (
      !app.taskClasses ||
      candidate.taskClass === null ||
      !app.taskClasses.includes(candidate.taskClass)
    ) {
      return ["target"];
    }
    if (app.actorKinds) {
      const kind = candidate.attrs.actorKind;
      if (kind === null || !app.actorKinds.includes(kind)) failed.push("actorKinds");
    }
  } else {
    if (!app.motifs || candidate.motifKind === null || !app.motifs.includes(candidate.motifKind)) {
      return ["target"];
    }
    // actorKinds is a node-target gate; motif detectors encode their own.
  }

  // Every gate — min- and max-direction alike — evaluates the SUBSTITUTED
  // values, so the "unknown = lowest ordinal" story is consistent
  // everywhere. An unknown value therefore fails min-gates and passes
  // max-gates; where a max-gate pass would flatter (e.g. batching a task of
  // unknown duration), the same substitution keeps the impact score at its
  // floor and confidence low, so the opportunity self-corrects to the
  // bottom of the ranking instead of being silently hidden.
  if (app.minStructure && values.structureScore < STRUCTURE_SCORE[app.minStructure]) {
    failed.push("minStructure");
  }
  if (app.maxStructure && values.structureScore > STRUCTURE_SCORE[app.maxStructure]) {
    failed.push("maxStructure");
  }
  if (app.maxJudgment && values.judgmentScore < JUDGMENT_SCORE[app.maxJudgment]) {
    failed.push("maxJudgment");
  }
  if (app.minFrequency && values.frequencyScore < FREQUENCY_SCORE[app.minFrequency]) {
    failed.push("minFrequency");
  }
  if (app.minDuration && values.durationScore < DURATION_SCORE[app.minDuration]) {
    failed.push("minDuration");
  }
  if (app.maxDuration && values.durationScore > DURATION_SCORE[app.maxDuration]) {
    failed.push("maxDuration");
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface Match {
  /** The destination pattern (the last step, for sequences). */
  pattern: PatternDef;
  candidate: CandidateTarget;
  sequence: SequenceStep[];
  /** The pattern behind each sequence step, in order. */
  sequencePatterns: PatternDef[];
  /** Survivors of the sensitivity hard filter (final step), lowest effort first. */
  variants: SurvivingVariant[];
  /** Best surviving variant's effort per sequence step, in order. */
  stepBestEfforts: Effort[];
  /**
   * Structure score to SCORE with: the effective score normally; the
   * post-improvement score for sequences.
   */
  scoringStructureScore: number;
}

export interface MatchOutcome {
  matches: Match[];
  excluded: ExcludedOpportunity[];
}

const EFFORT_ORDER = { low: 0, medium: 1, high: 2 } as const;

function survivingVariants(pattern: PatternDef, sensitivity: Sensitivity): SurvivingVariant[] {
  return pattern.variants
    .filter((v) => SENSITIVITY_SCORE[v.sensitivityCeiling] >= SENSITIVITY_SCORE[sensitivity])
    .sort((a, b) => EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort])
    .map((v) => ({
      variantId: v.id,
      name: v.name,
      deployment: v.deployment,
      effort: v.effort,
      sensitivityCeiling: v.sensitivityCeiling,
    }));
}

export function matchCatalog(catalog: PatternDef[], candidates: CandidateTarget[]): MatchOutcome {
  const matches: Match[] = [];
  const excluded: ExcludedOpportunity[] = [];

  for (const candidate of candidates) {
    const values = effectiveValues(candidate.attrs);
    const evaluated = catalog.map((pattern) => ({
      pattern,
      failed: failedGates(pattern, candidate, values),
    }));
    const direct = evaluated.filter((e) => e.failed.length === 0).map((e) => e.pattern);

    const emit = (
      pattern: PatternDef,
      sequencePatterns: PatternDef[],
      scoringStructureScore: number,
    ): void => {
      // The hard filter applies to EVERY step's variants — a sequence whose
      // enabler cannot be deployed at this sensitivity is not a plan.
      const perStep = sequencePatterns.map((p) => survivingVariants(p, values.sensitivity));
      if (perStep.some((v) => v.length === 0)) {
        excluded.push({
          patternId: pattern.id,
          target: candidate.target,
          reason: `all variants exceed data sensitivity ${values.sensitivity}`,
        });
        return;
      }
      matches.push({
        pattern,
        candidate,
        sequence: sequencePatterns.map((p, i) => ({ order: i + 1, patternId: p.id })),
        sequencePatterns,
        variants: perStep[perStep.length - 1],
        stepBestEfforts: perStep.map((v) => v[0].effort),
        scoringStructureScore,
      });
    };

    for (const pattern of direct) {
      emit(pattern, [pattern], values.structureScore);
    }

    // Sequence composition: destination failed ONLY minStructure; a directly
    // applicable enabler raises structure to (at least) the gate.
    for (const { pattern, failed } of evaluated) {
      if (!(failed.length === 1 && failed[0] === "minStructure")) continue;
      const gate = pattern.applicability.minStructure!;
      const enablers = direct
        .filter(
          (q) =>
            q.id !== pattern.id &&
            q.improves !== undefined &&
            STRUCTURE_SCORE[q.improves.raisesTo] >= STRUCTURE_SCORE[gate],
        )
        .sort(
          (a, b) =>
            STRUCTURE_SCORE[b.improves!.raisesTo] - STRUCTURE_SCORE[a.improves!.raisesTo] ||
            a.id.localeCompare(b.id),
        );
      if (enablers.length === 0) continue;
      const enabler = enablers[0];
      const raisedScore = Math.max(
        values.structureScore,
        STRUCTURE_SCORE[enabler.improves!.raisesTo],
      );
      emit(pattern, [enabler, pattern], raisedScore);
    }
  }

  return { matches, excluded };
}
