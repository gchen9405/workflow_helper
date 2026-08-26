/** Applicability gates, conservative substitution, the sensitivity hard
 * filter, sequence composition, and motif attribute aggregation. */
import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  effectiveValues,
  matchCatalog,
} from "../src/pipeline/match.js";
import { detectMotifs } from "../src/pipeline/motifs.js";
import type { PatternDef, PatternVariant } from "../src/schema/catalog.js";
import { edge, node, profile, workflow } from "./helpers.js";

function variant(id: string, over: Partial<PatternVariant> = {}): PatternVariant {
  return {
    id,
    name: id,
    description: "d",
    deployment: "non_ai",
    sensitivityCeiling: "regulated",
    effort: "low",
    prerequisites: [],
    caveats: [],
    ...over,
  };
}

function pattern(id: string, over: Partial<PatternDef> = {}): PatternDef {
  return {
    id: `pat.${id}`,
    name: id,
    description: "d",
    automationClass: "ai_assist",
    applicability: { taskClasses: ["data_entry"] },
    feasibilityWeights: { base: 0.4, structure: 0.35, judgment: 0.25 },
    variants: [variant("v1")],
    advice: [],
    ...over,
  };
}

const nodeCandidates = (...profiles: Parameters<typeof buildCandidates>[0]) =>
  buildCandidates(profiles, []);

describe("effectiveValues", () => {
  it("substitutes unknowns conservatively and records each substitution", () => {
    const values = effectiveValues({
      frequency: null,
      duration: "multi_day",
      structure: null,
      judgment: "routine",
      dataSensitivity: null,
      actorKind: "human",
      errorProneness: null,
    });
    expect(values.frequencyScore).toBe(1);
    expect(values.durationScore).toBe(5);
    expect(values.structureScore).toBe(1);
    expect(values.judgmentScore).toBe(3);
    expect(values.sensitivity).toBe("regulated");
    expect(values.errorBonus).toBe(0);
    expect(values.substitutions).toHaveLength(3); // frequency, structure, sensitivity
    expect(values.substitutions.join(" ")).toContain("regulated");
  });
});

describe("matchCatalog — gates", () => {
  it("matches on task class and rejects other classes", () => {
    const catalog = [pattern("entry")];
    const { matches } = matchCatalog(
      catalog,
      nodeCandidates(profile("a"), profile("b", { taskClass: "calculation" })),
    );
    expect(matches.map((m) => `${m.pattern.id}@${m.candidate.nodeIds[0]}`)).toEqual([
      "pat.entry@a",
    ]);
  });

  it("evaluates ordinal gates on substituted values", () => {
    const catalog = [
      pattern("rules", {
        applicability: {
          taskClasses: ["data_entry"],
          minStructure: "fully_rule_based",
          maxJudgment: "routine",
          minFrequency: "daily",
        },
      }),
    ];
    const pass = profile("a", { structure: "fully_rule_based", judgment: "none" });
    const failJudgment = profile("b", { structure: "fully_rule_based", judgment: "expert" });
    const unknownStructure = profile("c", { structure: null });
    const { matches } = matchCatalog(catalog, nodeCandidates(pass, failJudgment, unknownStructure));
    expect(matches.map((m) => m.candidate.nodeIds[0])).toEqual(["a"]);
  });

  it("min/max duration and max structure gates", () => {
    const catalog = [
      pattern("batchlike", {
        applicability: { taskClasses: ["data_entry"], maxDuration: "5_to_30_min" },
      }),
      pattern("delegatelike", {
        applicability: { taskClasses: ["data_entry"], minDuration: "2_h_to_1_day" },
      }),
      pattern("standardizelike", {
        applicability: { taskClasses: ["data_entry"], maxStructure: "guidelines_with_exceptions" },
      }),
    ];
    const quick = profile("quick", { duration: "under_5_min", structure: "fully_rule_based" });
    const long = profile("long", { duration: "multi_day", structure: "case_by_case" });
    const { matches } = matchCatalog(catalog, nodeCandidates(quick, long));
    expect(matches.map((m) => `${m.pattern.id}@${m.candidate.nodeIds[0]}`)).toEqual([
      "pat.batchlike@quick",
      "pat.delegatelike@long",
      "pat.standardizelike@long",
    ]);
  });

  it("actorKinds gate blocks ai_agent and unknown actors on node targets", () => {
    const catalog = [
      pattern("assist", { applicability: { taskClasses: ["data_entry"], actorKinds: ["human", "mixed"] } }),
    ];
    const { matches } = matchCatalog(
      catalog,
      nodeCandidates(
        profile("human_step"),
        profile("agent_step", { actorKind: "ai_agent" }),
        profile("unknown_step", { actorKind: null }),
      ),
    );
    expect(matches.map((m) => m.candidate.nodeIds[0])).toEqual(["human_step"]);
  });
});

describe("matchCatalog — sensitivity hard filter", () => {
  const catalog = [
    pattern("ai", {
      variants: [
        variant("external", { deployment: "external_saas", sensitivityCeiling: "internal", effort: "low" }),
        variant("internal", { deployment: "internal_endpoint", sensitivityCeiling: "confidential", effort: "medium" }),
        variant("onprem", { deployment: "on_prem", sensitivityCeiling: "regulated", effort: "high" }),
      ],
    }),
    pattern("cloud_only", {
      variants: [variant("external", { deployment: "external_saas", sensitivityCeiling: "internal" })],
    }),
  ];

  it("drops variants below the target's sensitivity, keeping effort order", () => {
    const { matches } = matchCatalog(
      catalog,
      nodeCandidates(profile("a", { dataSensitivity: "confidential" })),
    );
    const ai = matches.find((m) => m.pattern.id === "pat.ai")!;
    expect(ai.variants.map((v) => v.variantId)).toEqual(["internal", "onprem"]);
  });

  it("a pattern losing every variant lands in excluded with the reason — never silently dropped", () => {
    const { matches, excluded } = matchCatalog(
      catalog,
      nodeCandidates(profile("a", { dataSensitivity: "regulated" })),
    );
    expect(matches.map((m) => m.pattern.id)).toEqual(["pat.ai"]);
    expect(excluded).toEqual([
      {
        patternId: "pat.cloud_only",
        target: { kind: "node", nodeId: "a" },
        reason: "all variants exceed data sensitivity regulated",
      },
    ]);
  });

  it("unknown sensitivity is treated as regulated", () => {
    const { matches, excluded } = matchCatalog(
      catalog,
      nodeCandidates(profile("a", { dataSensitivity: null })),
    );
    const ai = matches.find((m) => m.pattern.id === "pat.ai")!;
    expect(ai.variants.map((v) => v.variantId)).toEqual(["onprem"]);
    expect(excluded.map((e) => e.patternId)).toEqual(["pat.cloud_only"]);
  });
});

describe("matchCatalog — sequences", () => {
  const enabler = pattern("standardize", {
    applicability: { taskClasses: ["data_entry"], maxStructure: "guidelines_with_exceptions" },
    improves: { attribute: "structure", raisesTo: "mostly_rules" },
  });
  const destination = pattern("automate", {
    applicability: { taskClasses: ["data_entry"], minStructure: "mostly_rules" },
    variants: [variant("v1", { effort: "medium" })],
  });

  it("emits [enabler, destination] when only minStructure fails and an improver applies", () => {
    const { matches } = matchCatalog(
      [enabler, destination],
      nodeCandidates(profile("a", { structure: "guidelines_with_exceptions" })),
    );
    const sequence = matches.find((m) => m.pattern.id === "pat.automate")!;
    expect(sequence.sequence).toEqual([
      { order: 1, patternId: "pat.standardize" },
      { order: 2, patternId: "pat.automate" },
    ]);
    expect(sequence.scoringStructureScore).toBe(3); // raised to mostly_rules
    expect(sequence.stepBestEfforts).toEqual(["low", "medium"]);
    // The enabler still matches on its own as well.
    expect(matches.some((m) => m.pattern.id === "pat.standardize" && m.sequence.length === 1)).toBe(true);
  });

  it("emits no sequence when the destination also fails another gate", () => {
    const gated = pattern("automate2", {
      applicability: {
        taskClasses: ["data_entry"],
        minStructure: "mostly_rules",
        actorKinds: ["human"],
      },
    });
    const { matches } = matchCatalog(
      [enabler, gated],
      nodeCandidates(profile("a", { structure: "guidelines_with_exceptions", actorKind: "ai_agent" })),
    );
    expect(matches.some((m) => m.pattern.id === "pat.automate2")).toBe(false);
  });

  it("emits no sequence when no applicable pattern raises structure far enough", () => {
    const weakEnabler = pattern("weak", {
      applicability: { taskClasses: ["data_entry"] },
      improves: { attribute: "structure", raisesTo: "guidelines_with_exceptions" },
    });
    const strict = pattern("strict", {
      applicability: { taskClasses: ["data_entry"], minStructure: "fully_rule_based" },
    });
    const { matches } = matchCatalog(
      [weakEnabler, strict],
      nodeCandidates(profile("a", { structure: "case_by_case" })),
    );
    expect(matches.some((m) => m.pattern.id === "pat.strict")).toBe(false);
  });
});

describe("motif targets and aggregation", () => {
  it("matches motif-branch patterns and aggregates attributes worst-case", () => {
    const wf = workflow({
      nodes: [node("extract"), node("enter")],
      edges: [edge("e1", "extract", "enter")],
    });
    const profiles = [
      profile("extract", {
        taskClass: "data_extraction",
        frequency: "daily",
        structure: "mostly_rules",
        dataSensitivity: "internal",
      }),
      profile("enter", {
        taskClass: "data_entry",
        frequency: "weekly",
        structure: "guidelines_with_exceptions",
        dataSensitivity: "confidential",
      }),
    ];
    const motifs = detectMotifs(wf, profiles);
    const candidates = buildCandidates(profiles, motifs);
    const motifCandidate = candidates.find((c) => c.target.kind === "motif")!;
    expect(motifCandidate.attrs.frequency).toBe("daily"); // max
    expect(motifCandidate.attrs.structure).toBe("guidelines_with_exceptions"); // min
    expect(motifCandidate.attrs.dataSensitivity).toBe("confidential"); // max

    const catalog = [pattern("integrate", { applicability: { motifs: ["manual_data_transfer_chain"] } })];
    const { matches } = matchCatalog(catalog, candidates);
    expect(matches).toHaveLength(1);
    expect(matches[0].candidate.target.kind).toBe("motif");
  });

  it("one member's unknown sensitivity makes the aggregate unknown (→ regulated)", () => {
    const wf = workflow({
      nodes: [node("extract"), node("enter")],
      edges: [edge("e1", "extract", "enter")],
    });
    const profiles = [
      profile("extract", { taskClass: "data_extraction", dataSensitivity: "public" }),
      profile("enter", { taskClass: "data_entry", dataSensitivity: null }),
    ];
    const candidates = buildCandidates(profiles, detectMotifs(wf, profiles));
    const motifCandidate = candidates.find((c) => c.target.kind === "motif")!;
    expect(motifCandidate.attrs.dataSensitivity).toBeNull();
    expect(effectiveValues(motifCandidate.attrs).sensitivity).toBe("regulated");
  });
});
