/** The single LLM stage: draft validation, the invariant, and chunking. */
import { describe, expect, it } from "vitest";
import { LlmRepairExhaustedError } from "workflow-preprocessor";
import { profileNodes } from "../src/pipeline/profile.js";
import { checkProfileDraft } from "../src/schema/profile.js";
import { FakeLlm, profileHandler } from "./fakeLlm.js";
import { node, profile } from "./helpers.js";

describe("checkProfileDraft", () => {
  it("accepts a complete, invariant-satisfying draft", () => {
    expect(checkProfileDraft({ profiles: [profile("a")] }, ["a"])).toEqual([]);
  });

  it("flags missing, extra, and duplicate node ids", () => {
    expect(checkProfileDraft({ profiles: [] }, ["a"]).join(" ")).toContain("missing profile");
    expect(checkProfileDraft({ profiles: [profile("ghost")] }, ["a"]).join(" ")).toContain(
      "unknown node id",
    );
    expect(
      checkProfileDraft({ profiles: [profile("a"), profile("a")] }, ["a"]).join(" "),
    ).toContain("duplicate");
  });

  it("enforces value ⇔ basis/evidence in both directions", () => {
    const missingEvidence = profile("a");
    missingEvidence.attributes.frequency = { value: "daily", basis: null, evidence: null };
    expect(checkProfileDraft({ profiles: [missingEvidence] }, ["a"]).join(" ")).toContain(
      "no basis",
    );

    const strayEvidence = profile("a");
    strayEvidence.attributes.frequency = { value: null, basis: "implied", evidence: "hm" };
    expect(checkProfileDraft({ profiles: [strayEvidence] }, ["a"]).join(" ")).toContain(
      "null but carries",
    );
  });
});

describe("profileNodes", () => {
  it("profiles nodes through the real schema and preserves node order", async () => {
    const llm = new FakeLlm({
      profiling: profileHandler({ a: profile("a"), b: profile("b") }),
    });
    const result = await profileNodes(llm, { name: "Flow", description: null }, [
      node("a"),
      node("b"),
    ]);
    expect(result.map((p) => p.nodeId)).toEqual(["a", "b"]);
    expect(llm.calls).toBe(1);
  });

  it("chunks large workflows: 25 nodes → 3 calls, ≤12 each", async () => {
    const nodes = Array.from({ length: 25 }, (_, i) => node(`n${i}`));
    const byId = Object.fromEntries(nodes.map((n) => [n.id, profile(n.id)]));
    const llm = new FakeLlm({ profiling: profileHandler(byId) });
    const result = await profileNodes(llm, { name: null, description: null }, nodes);
    expect(llm.calls).toBe(3);
    expect(result.map((p) => p.nodeId)).toEqual(nodes.map((n) => n.id));
  });

  it("surfaces semantic failures as repair exhaustion (the client's job upstream)", async () => {
    const llm = new FakeLlm({
      profiling: () => ({ profiles: [] }), // answers nothing it was asked
    });
    await expect(
      profileNodes(llm, { name: null, description: null }, [node("a")]),
    ).rejects.toBeInstanceOf(LlmRepairExhaustedError);
  });
});
