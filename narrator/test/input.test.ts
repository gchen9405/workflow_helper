/** The input boundary: envelope validation over real recommender output. */
import { describe, expect, it } from "vitest";
import { hasBody, loadRecommendation } from "../src/schema/input.js";
import { claimsPartialFixture, inheritedFixture, reFixture, unsuitableFixture } from "./fixtures.js";

describe("loadRecommendation", () => {
  it("loads a recommended result with its ranked body", async () => {
    const { json } = await reFixture();
    const loaded = loadRecommendation(json);
    expect(loaded.status).toBe("recommended");
    if (!hasBody(loaded)) throw new Error(loaded.status);
    expect(loaded.workflowName).toBe("RE knowledge pipeline");
    expect(loaded.opportunities.length).toBeGreaterThan(0);
    expect(loaded.profiles).toHaveLength(5);
    expect(loaded.motifs.some((m) => m.kind === "rework_loop")).toBe(true);
    expect(loaded.source.preprocessStatus).toBe("validated");
  });

  it("loads a partial result with its open questions", async () => {
    const { json } = await claimsPartialFixture();
    const loaded = loadRecommendation(json);
    expect(loaded.status).toBe("partial");
    if (loaded.status !== "partial") return;
    expect(loaded.reason).toContain("ended clarification");
    expect(loaded.openQuestions.map((q) => q.id)).toContain("missing_attribute:complete:duration");
    expect(loaded.opportunities.length).toBeGreaterThan(0);
  });

  it("loads inherited questions and skipped nodes from a partial preprocessor input", async () => {
    const { json } = await inheritedFixture();
    const loaded = loadRecommendation(json);
    if (!hasBody(loaded)) throw new Error(loaded.status);
    expect(loaded.source.preprocessStatus).toBe("partial");
    expect(loaded.skippedNodes).toEqual([{ nodeId: "mystery", why: "unknown_type" }]);
    expect(loaded.inheritedOpenQuestions.map((q) => q.id)).toEqual(["missing_node_type:mystery", "dead_end:a"]);
  });

  it("loads an unsuitable result", () => {
    const loaded = loadRecommendation(unsuitableFixture());
    expect(loaded.status).toBe("unsuitable");
    expect(hasBody(loaded)).toBe(false);
  });

  it("rejects values that are not recommender results, naming the problem", () => {
    expect(() => loadRecommendation({ hello: "world" })).toThrow(/not a recommender result/);
    expect(() => loadRecommendation({ status: "validated", schema: {} })).toThrow(/not a recommender result/);
    expect(() => loadRecommendation(null)).toThrow(/not a recommender result/);
  });

  it("rejects a body whose quoted fields are malformed", async () => {
    const { json } = await reFixture();
    const broken = JSON.parse(JSON.stringify(json)) as { opportunities: { score: { total: unknown } }[] };
    broken.opportunities[0].score.total = "thirty";
    expect(() => loadRecommendation(broken)).toThrow(/opportunities\.0\.score\.total/);
  });

  it("tolerates additive fields and defaults optional lists", async () => {
    const { json } = await reFixture();
    const extended = { ...(json as object), futureField: { anything: true } } as Record<string, unknown>;
    delete extended.excluded;
    delete extended.rounds;
    const loaded = loadRecommendation(extended);
    if (!hasBody(loaded)) throw new Error(loaded.status);
    expect(loaded.excluded).toEqual([]);
    expect(loaded.rounds).toEqual([]);
    expect("futureField" in loaded).toBe(false);
  });
});
