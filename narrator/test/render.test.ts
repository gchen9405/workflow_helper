/**
 * The deterministic renderer over real recommender output: every section,
 * flow order, provenance marks, sequences, exclusions, open questions, and
 * the unsuitable notice.
 */
import { describe, expect, it } from "vitest";
import { STARTER_CATALOG } from "workflow-recommender";
import { loadRecommendation } from "../src/schema/input.js";
import {
  assembleReport,
  detailCount,
  flowOrder,
  renderBody,
  renderTitle,
  type ReportContext,
} from "../src/render/report.js";
import {
  claimsFixture,
  claimsPartialFixture,
  inheritedFixture,
  reFixture,
  reKnowledgePipeline,
  unsuitableFixture,
} from "./fixtures.js";
import type { Workflow } from "workflow-preprocessor";

function context(json: unknown, workflow: Workflow | null, over: Partial<ReportContext> = {}): ReportContext {
  return {
    result: loadRecommendation(json),
    workflow,
    workflowPath: workflow ? "/somewhere/re.json" : null,
    catalog: STARTER_CATALOG,
    top: 5,
    inputLabel: "re.recommendations.json",
    ...over,
  };
}

describe("flowOrder", () => {
  it("walks from the start node and appends unreached nodes, cycle-safe", () => {
    const order = flowOrder(reKnowledgePipeline());
    expect(order).toEqual(["s", "collect", "distill", "expose", "agent_assist", "verify", "f"]);
  });
});

describe("detailCount", () => {
  it("writes up `top` and tabulates the rest, unless only one or two would remain", () => {
    expect(detailCount(10, 5)).toBe(5);
    expect(detailCount(7, 5)).toBe(7);
    expect(detailCount(3, 5)).toBe(3);
    expect(detailCount(5, 0)).toBe(0);
  });
});

describe("renderTitle", () => {
  it("names the workflow, the source, both statuses, and where step names came from", async () => {
    const { json, workflow } = await reFixture();
    const title = renderTitle(context(json, workflow));
    expect(title).toMatch(/^# Improvement report — RE knowledge pipeline/);
    expect(title).toContain("`re.recommendations.json`");
    expect(title).toContain("**recommended**");
    expect(title).toContain("preprocessor status validated");
    expect(title).toContain("step names from `re.json`");
  });

  it("says honestly when step names are unavailable", async () => {
    const { json } = await reFixture();
    expect(renderTitle(context(json, null))).toContain("step names unavailable");
  });
});

describe("renderBody — the RE knowledge pipeline", () => {
  it("lists the steps in flow order with labels, classes, and provenance marks", async () => {
    const { json, workflow } = await reFixture();
    const body = renderBody(context(json, workflow));
    const glance = body.split("## Shapes worth attention")[0];
    expect(glance).toContain("## The workflow at a glance");
    expect(glance).toContain('"RE knowledge pipeline" has 5 steps the recommender could analyse (7 nodes including start and end)');
    const collect = glance.indexOf("**Collect RE knowledge sources");
    const verify = glance.indexOf("**Verify with humans");
    expect(collect).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(collect);
    // Inferred values carry the * mark; the explicit AI-agent actor does not.
    expect(glance).toContain("research gathering*");
    expect(glance).toContain("runs weekly*");
    expect(glance).toContain("done by an AI agent;");
    expect(glance).toContain("(actor: AI agent)");
    expect(glance).toContain("Values marked *");
    // The back edge is narrated.
    expect(glance).toContain('"Verify with humans and/or benchmarks" loops back to "Distill RE knowledge for AI-agent consumption" (needs iteration)');
    expect(glance).toContain("the flow branches");
  });

  it("refers to steps by id when no workflow is available", async () => {
    const { json } = await reFixture();
    const body = renderBody(context(json, null));
    expect(body).toContain("**`collect`**");
    expect(body).toContain("In the order they were profiled");
    expect(body).not.toContain("loops back");
  });

  it("describes the detected rework loop with its gloss and member steps", async () => {
    const { json, workflow } = await reFixture();
    const body = renderBody(context(json, workflow));
    expect(body).toContain("## Shapes worth attention");
    expect(body).toMatch(/\*\*Rework loop\*\* \(a cycle that keeps sending work back/);
    const shapes = body.split("## Shapes worth attention")[1].split("## Recommendations")[0];
    // Members are listed in the motif's (sorted) order, by label.
    expect(shapes).toContain('Steps: "Agent assists with RE / software-understanding task", "Distill RE knowledge for AI-agent consumption"');
    expect(shapes).toContain('"Verify with humans and/or benchmarks".');
  });

  it("writes up the top opportunities in full and tabulates the rest", async () => {
    const { json, workflow, result } = await reFixture();
    if (result.status !== "recommended") throw new Error(result.status);
    const ctx = context(json, workflow, { top: 2 });
    const body = renderBody(ctx);
    const n = result.opportunities.length;
    expect(n).toBeGreaterThan(4);
    expect(body).toContain("### 1. ");
    expect(body).toContain("### 2. ");
    expect(body).not.toContain("### 3. ");
    expect(body).toContain("### Further opportunities");
    expect(body).toContain(`The top 2 are written up in full; the remaining ${n - 2} are listed`);
    // Every opportunity appears exactly once, by rank.
    for (let rank = 3; rank <= n; rank++) expect(body).toContain(`| ${rank} | `);
    // The top one quotes its score and its deterministic explanation verbatim.
    const top = result.opportunities[0];
    expect(body).toContain(`**Score ${top.score.total}/100**`);
    expect(body).toContain(top.explanation);
  });

  it("names the pattern and the best variant with its prerequisites from the catalog", async () => {
    const { json, workflow, result } = await reFixture();
    if (result.status !== "recommended") throw new Error(result.status);
    const body = renderBody(context(json, workflow, { top: 100 }));
    const eval_ = result.opportunities.find((o) => o.id === "pat.eval_harness_automation@verify")!;
    const pattern = STARTER_CATALOG.find((p) => p.id === "pat.eval_harness_automation")!;
    const variant = pattern.variants.find((v) => v.id === eval_.variants[0].variantId)!;
    expect(body).toContain(`${pattern.name} — for "Verify with humans and/or benchmarks"`);
    expect(body).toContain(pattern.description);
    expect(body).toContain(`*${variant.name}* — ${variant.description}`);
    if (variant.prerequisites.length > 0) expect(body).toContain(`Prerequisites: ${variant.prerequisites.join("; ")}`);
    expect(body).toContain("**Confidence: medium**, because:");
    expect(eval_.confidenceReasons.length).toBeGreaterThan(0);
    for (const reason of eval_.confidenceReasons) expect(body).toContain(`- ${reason}`);
  });

  it("includes the appendix: score legend, one profile row per step, clarification history", async () => {
    const { json, workflow } = await reFixture();
    const body = renderBody(context(json, workflow));
    expect(body).toContain("### How to read the scores");
    expect(body).toContain("### Step profiles");
    const rows = body.split("\n").filter((l) => /^\| (Collect|Distill|Expose|Agent|Verify)/.test(l));
    expect(rows).toHaveLength(5);
    expect(body).toContain("No clarification rounds were run.");
  });

  it("has no open-questions or exclusions section when there are none", async () => {
    const { json, workflow } = await reFixture();
    const body = renderBody(context(json, workflow));
    expect(body).not.toContain("## Open questions");
    expect(body).not.toContain("## Ruled out");
  });
});

describe("renderBody — claims intake (regulated data)", () => {
  it("renders two-step sequences and sensitivity exclusions", async () => {
    const { json, workflow, result } = await claimsFixture();
    if (result.status !== "recommended") throw new Error(result.status);
    expect(result.opportunities.some((o) => o.sequence.length > 1)).toBe(true);
    expect(result.excluded.length).toBeGreaterThan(0);
    const body = renderBody(context(json, workflow, { top: 100 }));
    expect(body).toContain("Standardize the inputs, then Automate extraction with AI — for \"Extract claim details from the submitted forms\"");
    expect(body).toContain("**Do this in two steps.** First *Standardize the inputs*");
    expect(body).toContain("## Ruled out by data sensitivity");
    expect(body).toMatch(/- \*\*.+\*\* for ".+" — all variants exceed data sensitivity regulated\./);
    expect(body).toContain("touches regulated data");
  });
});

describe("renderBody — partial results", () => {
  it("lists the open attribute questions and the reason the recommender stopped", async () => {
    const { json, workflow } = await claimsPartialFixture();
    const body = renderBody(context(json, workflow, { top: 100 }));
    expect(body).toContain("## Open questions");
    expect(body).toContain("The recommender stopped because the user ended clarification.");
    expect(body).toContain("1 attribute question remains open");
    expect(body).toMatch(/1\. .*Is the claim complete\?/);
    expect(body).toContain("not yet known: duration");
    expect(body).toContain("- duration unknown — scored at the lowest value (under 5 minutes)");
  });

  it("narrates skipped nodes, inherited questions, and which targets they touch", async () => {
    const { json, workflow } = await inheritedFixture();
    const body = renderBody(context(json, workflow));
    expect(body).toContain("1 node could not be analysed because the preprocessor left its type unknown: `mystery`.");
    expect(body).toContain("Questions still open from the preprocessor");
    expect(body).toContain("- What happens after \"Enter the order into SAP\"? (`dead_end:a`)");
    expect(body).toContain("**Open questions from the preprocessor touch this target:** \"What happens after \\\"Enter the order into SAP\\\"?\" (`dead_end:a`)".replace(/\\"/g, '"'));
    expect(body).toContain("**Confidence: low**, because:");
    // Explicit-basis values carry no mark.
    expect(body).toContain("data entry;");
  });
});

describe("renderBody — unsuitable", () => {
  it("writes a notice with advice keyed on the reason", () => {
    const ctx = context(unsuitableFixture(), null, { inputLabel: "x.recommendations.json" });
    const body = renderBody(ctx);
    expect(body).toContain("## Nothing to recommend on");
    expect(body).toContain("it is a financial summary");
    expect(body).toContain("run workflow-preprocessor again");
    const report = assembleReport(ctx, null, body);
    expect(report).toMatch(/^# Improvement report — \(unnamed workflow\)/);
    expect(report).not.toContain("## Summary");
  });

  it("gives different advice for the other unsuitable reasons", () => {
    expect(renderBody(context(unsuitableFixture("the workflow contains no task or decision steps to recommend on"), null))).toContain("only start/end nodes");
    expect(renderBody(context(unsuitableFixture("could not profile the workflow's steps (boom)"), null))).toContain("--check");
    expect(renderBody(context(unsuitableFixture("something else"), null))).toContain("Review the reason above");
  });
});

describe("renderBody — hygiene", () => {
  it("never leaks undefined/null or raw snake_case tokens into the prose", async () => {
    for (const fx of [await reFixture(), await claimsFixture(), await claimsPartialFixture(), await inheritedFixture()]) {
      const body = renderBody(context(fx.json, fx.workflow, { top: 100 }));
      expect(body).not.toMatch(/\bundefined\b/);
      expect(body).not.toMatch(/\bnull\b/);
      // Prose sections (before the appendix table) should not show raw enum tokens.
      const prose = body.split("### Step profiles")[0];
      expect(prose).not.toMatch(/\b(many_per_day|5_to_30_min|guidelines_with_exceptions|ai_agent|non_ai|on_prem)\b/);
    }
  });
});
