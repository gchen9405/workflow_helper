/** The real catalog data must satisfy its own schema and design rules. */
import { describe, expect, it } from "vitest";
import { STARTER_CATALOG } from "../src/catalog/patterns.js";
import { validateCatalog } from "../src/schema/catalog.js";

describe("starter catalog", () => {
  it("passes validateCatalog", () => {
    expect(validateCatalog(STARTER_CATALOG)).toEqual([]);
  });

  it("rejects malformed entries, duplicate ids, and target-less patterns", () => {
    expect(validateCatalog([{ id: "nope" }])).not.toEqual([]);
    const entry = STARTER_CATALOG[0];
    expect(validateCatalog([entry, entry]).join(" ")).toContain("duplicate pattern id");
    const targetless = { ...entry, id: "pat.targetless", applicability: {} };
    expect(validateCatalog([targetless]).join(" ")).toContain("neither taskClasses nor motifs");
  });

  it("AI-adoption patterns gate on human/mixed actors; knowledge-work AI patterns deliberately do not", () => {
    const adoption = [
      "pat.ai_extraction_assist",
      "pat.ai_extraction_automate",
      "pat.ai_drafting_assist",
      "pat.ai_classification_routing",
      "pat.ai_qa_check",
      "pat.ai_summarize_monitoring",
    ];
    for (const id of adoption) {
      const pattern = STARTER_CATALOG.find((p) => p.id === id)!;
      expect(pattern.applicability.actorKinds, id).toEqual(["human", "mixed"]);
    }
    // These serve steps ALREADY performed by AI (better knowledge, better evals).
    for (const id of ["pat.rag_knowledge_base", "pat.eval_harness_automation"]) {
      const pattern = STARTER_CATALOG.find((p) => p.id === id)!;
      expect(pattern.applicability.actorKinds, id).toBeUndefined();
    }
  });

  it("sensitivity ceilings encode the deployment posture", () => {
    for (const pattern of STARTER_CATALOG) {
      for (const variant of pattern.variants) {
        if (variant.deployment === "external_saas") {
          // External services never see confidential/regulated data.
          expect(["public", "internal", "confidential"]).toContain(variant.sensitivityCeiling);
          expect(variant.sensitivityCeiling).not.toBe("regulated");
        }
        if (variant.deployment === "non_ai" || variant.deployment === "on_prem") {
          expect(variant.sensitivityCeiling).toBe("regulated");
        }
      }
    }
  });

  it("the standardize patterns raise structure far enough to enable extraction automation", () => {
    const standardize = STARTER_CATALOG.find((p) => p.id === "pat.standardize_inputs")!;
    const automate = STARTER_CATALOG.find((p) => p.id === "pat.ai_extraction_automate")!;
    expect(standardize.improves?.raisesTo).toBe(automate.applicability.minStructure);
  });

  it("every entry carries the (empty) lessons-learned advice slot", () => {
    for (const pattern of STARTER_CATALOG) {
      expect(pattern.advice).toEqual([]);
    }
  });
});
