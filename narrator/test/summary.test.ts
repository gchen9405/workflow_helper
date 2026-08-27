/**
 * The summary layer: the grounding check, the model call through a stubbed
 * client, the deterministic summary, and the section renderer.
 */
import { describe, expect, it } from "vitest";
import { LlmRepairExhaustedError } from "workflow-preprocessor";
import { STARTER_CATALOG } from "workflow-recommender";
import { hasBody, loadRecommendation } from "../src/schema/input.js";
import { checkSummary, collectFacts, summarize, type ModelSummary } from "../src/llm/summary.js";
import { deterministicSummary, renderSummarySection } from "../src/render/summary.js";
import { renderBody, type ReportContext } from "../src/render/report.js";
import { FakeLlm } from "./fakeLlm.js";
import { claimsPartialFixture, groundedSummaryFor, reFixture } from "./fixtures.js";

const facts = { totals: [30, 24, 12] };

function summary(over: Partial<ModelSummary> = {}): ModelSummary {
  return {
    headline: "Automate the evaluation harness first.",
    overview: "The top recommendation scores 30/100.\n\nConfidence is medium.",
    takeaways: ["Start with the harness."],
    firstStep: "Script the benchmark runs.",
    caveats: [],
    ...over,
  };
}

describe("checkSummary", () => {
  it("accepts a grounded summary", () => {
    expect(checkSummary(summary(), facts)).toEqual([]);
  });

  it("rejects a score no recommendation has, in either wording", () => {
    expect(checkSummary(summary({ overview: "It scores 31/100." }), facts)).toEqual([
      expect.stringContaining("31/100"),
    ]);
    expect(checkSummary(summary({ takeaways: ["Scores 99 out of 100."] }), facts)[0]).toContain("takeaways[0]");
  });

  it("rejects internal identifiers", () => {
    const errors = checkSummary(summary({ firstStep: "Apply pat.eval_harness_automation." }), facts);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"pat.eval_harness_automation"');
    expect(checkSummary(summary({ caveats: ["See motif.rework_loop:a,b."] }), facts)).toHaveLength(1);
  });

  it("rejects the internal score arithmetic — the summary is the non-technical layer", () => {
    const errors = checkSummary(summary({ overview: "It wins on impact 0.44 and feasibility 0.683." }), facts);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('"impact 0.44"');
    expect(errors[1]).toContain('"feasibility 0.683"');
    expect(checkSummary(summary({ takeaways: ["Constraint of .56 holds it back."] }), facts)[0]).toContain("takeaways[0]");
    // Plain-language reasons, and the bands the report prints, are fine.
    expect(checkSummary(summary({ overview: "A Promising change: the step runs many times a day." }), facts)).toEqual([]);
  });

  it("rejects an over-long overview, an over-long headline, and markdown headings", () => {
    const long = Array.from({ length: 260 }, () => "word").join(" ");
    expect(checkSummary(summary({ overview: long }), facts)[0]).toMatch(/overview is 260 words/);
    const headline = Array.from({ length: 30 }, () => "word").join(" ");
    expect(checkSummary(summary({ headline }), facts)[0]).toMatch(/headline is 30 words/);
    expect(checkSummary(summary({ overview: "## Summary\n\nText." }), facts)[0]).toMatch(/markdown heading/);
  });

  it("reports every problem at once so one repair round can fix them all", () => {
    const errors = checkSummary(summary({ overview: "Scores 5/100 via pat.x.\n# Heading" }), facts);
    expect(errors).toHaveLength(3);
  });
});

describe("summarize", () => {
  async function reContext() {
    const { json, workflow } = await reFixture();
    const result = loadRecommendation(json);
    if (!hasBody(result)) throw new Error(result.status);
    const ctx: ReportContext = { result, workflow, workflowPath: null, catalog: STARTER_CATALOG, top: 5, inputLabel: "re.recommendations.json" };
    return { ctx, result, body: renderBody(ctx), json };
  }

  it("shows the model the deterministic body and returns its validated summary", async () => {
    const { result, body, json } = await reContext();
    const llm = new FakeLlm({ summary: () => groundedSummaryFor(json) });
    const out = await summarize(llm, body, collectFacts(result), { workflowName: result.workflowName, status: result.status });
    expect(out.headline).toContain("RE knowledge pipeline");
    expect(llm.calls).toBe(1);
    expect(llm.prompts[0]).toContain("<report>\n" + body + "\n</report>");
    expect(llm.prompts[0]).toContain(`scores, best first: ${result.opportunities[0].score.total}/100`);
  });

  it("an ungrounded summary goes through the repair loop and, exhausted, throws", async () => {
    const { result, body, json } = await reContext();
    const llm = new FakeLlm({ summary: () => ({ ...groundedSummaryFor(json), overview: "It scores 999/100." }) });
    await expect(
      summarize(llm, body, collectFacts(result), { workflowName: result.workflowName, status: result.status }),
    ).rejects.toBeInstanceOf(LlmRepairExhaustedError);
  });
});

describe("deterministicSummary", () => {
  async function ctxFor(fx: { json: unknown; workflow: import("workflow-preprocessor").Workflow }) {
    const result = loadRecommendation(fx.json);
    if (!hasBody(result)) throw new Error(result.status);
    const ctx: ReportContext = { result, workflow: fx.workflow, workflowPath: null, catalog: STARTER_CATALOG, top: 5, inputLabel: "x" };
    return { ctx, result };
  }

  it("leads with the top opportunity by name and target, and passes its own grounding check", async () => {
    const { ctx, result } = await ctxFor(await reFixture());
    const s = deterministicSummary(ctx, result);
    const top = result.opportunities[0];
    const name = STARTER_CATALOG.find((p) => p.id === top.patternId)!.name;
    expect(s.headline).toContain(name);
    expect(s.headline).toContain(`${result.opportunities.length} improvement opportunities for "RE knowledge pipeline"`);
    expect(s.overview).toContain(`${top.score.total}/100`);
    expect(s.takeaways.length).toBeGreaterThanOrEqual(3);
    expect(s.firstStep).toContain(top.variants[0].name);
    expect(checkSummary(s, collectFacts(result))).toEqual([]);
  });

  it("names the partial status, open questions, and exclusions", async () => {
    const { ctx, result } = await ctxFor(await claimsPartialFixture());
    const s = deterministicSummary(ctx, result);
    expect(s.overview).toContain("The result is partial");
    expect(s.takeaways.some((t) => /\d+ patterns? (is|are) ruled out by data sensitivity/.test(t))).toBe(true);
    expect(s.caveats.some((c) => /1 attribute question remains open/.test(c))).toBe(true);
    expect(checkSummary(s, collectFacts(result))).toEqual([]);
  });

  it("gives each slot a different fact, rather than restating the ranking", async () => {
    const { ctx, result } = await ctxFor(await claimsPartialFixture());
    const s = deterministicSummary(ctx, result);
    // The takeaways describe the SET: the action, the AI split, the lever,
    // the exclusions, the confidence spread …
    expect(s.takeaways[0]).toMatch(/^Start with /);
    expect(s.takeaways.some((t) => /need no AI at all/.test(t))).toBe(true);
    expect(s.takeaways.some((t) => /the single biggest lever — 2 of the top 3/.test(t))).toBe(true);
    expect(s.takeaways.some((t) => /marked low confidence/.test(t))).toBe(true);
    // … and none of them is a copy of a decision-table row (rank 2 and 3).
    for (const runnerUp of result.opportunities.slice(1, 3)) {
      const name = STARTER_CATALOG.find((p) => p.id === runnerUp.patternId)!.name;
      expect(s.takeaways.some((t) => t.startsWith(name))).toBe(false);
    }
    expect(checkSummary(s, collectFacts(result))).toEqual([]);
  });
});

describe("renderSummarySection", () => {
  it("labels a model summary and a deterministic one differently", () => {
    const model = renderSummarySection({ kind: "model", ...summary() });
    expect(model).toMatch(/^## Summary\n\n_Written by the model/);
    expect(model).toContain("**Automate the evaluation harness first.**");
    expect(model).toContain("**Key takeaways**\n\n- Start with the harness.");
    expect(model).toContain("**Suggested first step.** Script the benchmark runs.");
    expect(model).not.toContain("**Caveats**");

    const det = renderSummarySection({ kind: "deterministic", reason: "no model summary was requested", ...summary({ caveats: ["One."] }) });
    expect(det).toContain("_Written deterministically — no model summary was requested._");
    expect(det).toContain("**Caveats**\n\n- One.");
  });

  it("strips list markers and heading hashes the model may have added", () => {
    const out = renderSummarySection({
      kind: "model",
      ...summary({ takeaways: ["- first", "2. second", "• third"], overview: "### Overview\nText.", headline: "# Big" }),
    });
    expect(out).toContain("- first\n- second\n- third");
    expect(out).toContain("Overview\nText.");
    expect(out).toContain("**Big**");
  });
});
