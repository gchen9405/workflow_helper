/** Formula goldens, conservative defaults, the confidence table, ranking. */
import { describe, expect, it } from "vitest";
import { buildCandidates, matchCatalog } from "../src/pipeline/match.js";
import { buildOpportunities, type ScoringContext } from "../src/pipeline/score.js";
import { stampProfileProvenance, type RecommenderProvenance } from "../src/schema/profile.js";
import type { PatternDef, PatternVariant } from "../src/schema/catalog.js";
import type { NodeProfile } from "../src/schema/profile.js";
import { node, profile, workflow } from "./helpers.js";

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
    automationClass: "ai_automate",
    applicability: { taskClasses: ["data_entry"] },
    feasibilityWeights: { base: 0, structure: 0.6, judgment: 0.4 },
    variants: [variant("v1")],
    advice: [],
    ...over,
  };
}

/** Everything score-relevant grounded in the input. */
function originalProvenance(profiles: NodeProfile[]): Record<string, RecommenderProvenance> {
  return Object.fromEntries(
    Object.keys(stampProfileProvenance(profiles)).map((key) => [key, "original"]),
  );
}

function ctxFor(
  profiles: NodeProfile[],
  over: Partial<ScoringContext> = {},
): ScoringContext {
  return {
    workflow: workflow({ nodes: profiles.map((p) => node(p.nodeId)) }),
    motifs: [],
    provenance: originalProvenance(profiles),
    sourceStatus: "validated",
    inheritedQuestions: [],
    ...over,
  };
}

function opportunitiesFor(
  catalog: PatternDef[],
  profiles: NodeProfile[],
  over: Partial<ScoringContext> = {},
) {
  const { matches } = matchCatalog(catalog, buildCandidates(profiles, []));
  return buildOpportunities(matches, ctxFor(profiles, over));
}

describe("score formulas", () => {
  it("computes the golden case exactly", () => {
    const profiles = [
      profile("a", {
        frequency: "daily", // 4
        duration: "30_min_to_2_h", // 3
        structure: "fully_rule_based", // 4
        judgment: "none", // 4
        dataSensitivity: "internal",
      }),
    ];
    const [opp] = opportunitiesFor(
      [pattern("full", { variants: [variant("v1", { effort: "medium" })] })],
      profiles,
    );
    expect(opp.score.impact).toBe(0.48); // 4×3/25
    expect(opp.score.feasibility).toBe(1); // 0 + .6·(3/3) + .4·(3/3)
    expect(opp.score.constraint).toBe(0.85); // medium effort × internal friction 1.0
    expect(opp.score.total).toBe(41); // round(100 × .48 × 1 × .85)
    expect(opp.score.factors).toEqual({
      frequency: 4,
      duration: 3,
      errorBonus: 0,
      structure: 4,
      judgment: 4,
      sensitivityFriction: 1,
      effortFactor: 0.85,
      sequenceDiscount: 1,
    });
    expect(opp.confidence).toBe("high");
    expect(opp.confidenceReasons).toEqual([]);
    expect(opp.explanation).toContain("Total 41/100");
  });

  it("error-proneness raises impact, capped at 25", () => {
    const profiles = [
      profile("a", { frequency: "many_per_day", duration: "multi_day", errorProneness: "frequent" }),
    ];
    const [opp] = opportunitiesFor([pattern("full")], profiles);
    expect(opp.score.impact).toBe(1); // min(25+2, 25)/25
  });

  it("regulated data and sequences show up as constraint multipliers", () => {
    const enabler = pattern("std", {
      automationClass: "standardize",
      applicability: { taskClasses: ["data_entry"], maxStructure: "guidelines_with_exceptions" },
      feasibilityWeights: { base: 0.6, structure: 0.2, judgment: 0.2 },
      improves: { attribute: "structure", raisesTo: "mostly_rules" },
    });
    const destination = pattern("auto", {
      applicability: { taskClasses: ["data_entry"], minStructure: "mostly_rules" },
      variants: [variant("v1", { effort: "high" })],
    });
    const profiles = [
      profile("a", { structure: "guidelines_with_exceptions", dataSensitivity: "regulated" }),
    ];
    const opps = opportunitiesFor([enabler, destination], profiles);
    const seq = opps.find((o) => o.patternId === "pat.auto")!;
    expect(seq.sequence).toHaveLength(2);
    expect(seq.score.factors.structure).toBe(3); // post-improvement
    expect(seq.score.factors.sequenceDiscount).toBe(0.9);
    expect(seq.score.factors.sensitivityFriction).toBe(0.8);
    expect(seq.score.constraint).toBe(Math.round(0.7 * 0.8 * 0.9 * 1000) / 1000);
  });
});

describe("confidence", () => {
  it("conservative substitution ⇒ low, with the substitution named", () => {
    const profiles = [profile("a", { frequency: null })];
    const [opp] = opportunitiesFor([pattern("full")], profiles);
    expect(opp.confidence).toBe("low");
    expect(opp.confidenceReasons.join(" ")).toContain("frequency unknown");
    expect(opp.score.factors.frequency).toBe(1);
  });

  it("inferred values ⇒ medium (helpers stamp basis=implied)", () => {
    const profiles = [profile("a")];
    const opps = opportunitiesFor([pattern("full")], profiles, {
      provenance: stampProfileProvenance(profiles), // all inferred
    });
    expect(opps[0].confidence).toBe("medium");
    expect(opps[0].confidenceReasons.join(" ")).toContain("inferred");
  });

  it("a partial source ⇒ medium even with grounded values", () => {
    const profiles = [profile("a")];
    const [opp] = opportunitiesFor([pattern("full")], profiles, { sourceStatus: "partial" });
    expect(opp.confidence).toBe("medium");
  });

  it("an inherited open question touching the target ⇒ low, listed in affectedBy", () => {
    const profiles = [profile("a")];
    const [opp] = opportunitiesFor([pattern("full")], profiles, {
      inheritedQuestions: [
        { id: "dead_end:a", text: "What happens after a?", gap: { kind: "dead_end", nodeId: "a" } },
      ],
    });
    expect(opp.confidence).toBe("low");
    expect(opp.affectedBy).toEqual(["dead_end:a"]);
  });
});

describe("ranking", () => {
  it("orders by total, then breaks full ties lexicographically — deterministic output", () => {
    const profiles = [
      profile("big", { frequency: "many_per_day", duration: "multi_day" }),
      profile("small", { frequency: "ad_hoc", duration: "under_5_min" }),
    ];
    const twin1 = pattern("twin_a");
    const twin2 = pattern("twin_b");
    const opps = opportunitiesFor([twin2, twin1], profiles);
    expect(opps.map((o) => o.id)).toEqual([
      "pat.twin_a@big",
      "pat.twin_b@big",
      "pat.twin_a@small",
      "pat.twin_b@small",
    ]);
  });
});
