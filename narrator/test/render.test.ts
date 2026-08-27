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
import { SCORE_BANDS, lowerFirst, scoreBand } from "../src/render/phrases.js";
import {
  claimsFixture,
  claimsPartialFixture,
  inheritedFixture,
  reFixture,
  reKnowledgePipeline,
  unsuitableFixture,
} from "./fixtures.js";
import type { Workflow } from "workflow-preprocessor";

/** One section of the report, from its heading to the next heading of the same level. */
function section(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start === -1) throw new Error(`no section ${heading} in the report`);
  const rest = body.slice(start + heading.length);
  const level = heading.match(/^#+/)?.[0];
  const next = level ? rest.search(new RegExp(`\\n#{1,${level.length}} `)) : rest.indexOf("</details>");
  return next === -1 ? rest : rest.slice(0, next);
}

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
  it("says what the document is, and carries only the flags that colour the whole report", async () => {
    const { json, workflow } = await reFixture();
    const title = renderTitle(context(json, workflow));
    expect(title).toMatch(/^# Improvement report — RE knowledge pipeline/);
    expect(title).toContain("Changes worth making to this workflow, ranked");
    // A complete analysis with names in hand raises no flag …
    expect(title).not.toContain("partial");
    expect(title).not.toContain("Step names were unavailable");
    // … and the machine provenance moved to the appendix, where it is audited.
    expect(title).not.toContain("`re.recommendations.json`");
    const body = renderBody(context(json, workflow));
    expect(body).toContain("Generated from `re.recommendations.json`");
    expect(body).toContain("Recommender status: **recommended**");
    expect(body).toContain("Preprocessor status: validated.");
    expect(body).toContain("Step names came from `re.json`.");
  });

  it("flags a partial analysis up front, where it changes how everything below reads", async () => {
    const { json, workflow } = await claimsPartialFixture();
    const title = renderTitle(context(json, workflow));
    expect(title).toContain("**This analysis is partial**");
    expect(title).toContain("the user ended clarification");
    expect(title).toContain("1 question is still open");
  });

  it("says honestly when step names are unavailable", async () => {
    const { json } = await reFixture();
    expect(renderTitle(context(json, null))).toContain("**Step names were unavailable**");
    expect(renderBody(context(json, null))).toContain("Step names were unavailable, so steps are referred to by their internal ids.");
  });
});

describe("renderBody — the RE knowledge pipeline", () => {
  it("lists the steps in flow order with labels, classes, and provenance marks", async () => {
    const { json, workflow } = await reFixture();
    const body = renderBody(context(json, workflow));
    const glance = section(body, "## How the workflow runs today");
    expect(glance).toContain('"RE knowledge pipeline" has 5 steps we could analyse (7 nodes including start and end)');
    const collect = glance.indexOf("**Collect RE knowledge sources");
    const verify = glance.indexOf("**Verify with humans");
    expect(collect).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(collect);
    // Inferred values carry the * mark; the explicit AI-agent actor does not.
    expect(glance).toContain("research gathering*");
    expect(glance).toContain("Runs weekly*");
    expect(glance).toContain("done by an AI agent.");
    expect(glance).toContain("(actor: AI agent)");
    expect(glance).toContain("Values marked *");
    // The back edge is narrated.
    expect(glance).toContain('"Verify with humans and/or benchmarks" loops back to "Distill RE knowledge for AI-agent consumption" (needs iteration)');
    expect(glance).toContain("the flow branches");
  });

  it("shows the salient attributes inline and only flags the rest when notable", async () => {
    const { json, workflow } = await reFixture();
    const glance = section(renderBody(context(json, workflow)), "## How the workflow runs today");
    // Class, actor, frequency and duration lead every line …
    expect(glance).toContain("knowledge distillation*, done by a person*. Runs weekly*, 2 hours – 1 day each time*.");
    // … expert judgment and known errors are surfaced because they change a decision …
    expect(glance).toContain("Notable: needs expert judgment*.");
    expect(glance).toContain("Notable: occasionally goes wrong*.");
    // … and unremarkable structure/judgment values stay out of the decision layer.
    expect(glance).not.toContain("follows guidelines with exceptions");
    expect(glance).not.toContain("needs experienced judgment");
    // Nothing is lost: the appendix still carries every attribute of every step.
    const profiles = section(renderBody(context(json, workflow)), "<summary>The full step profiles</summary>");
    expect(profiles).toContain("guidelines with exceptions*");
    expect(profiles).toContain("experienced judgment*");
    expect(glance).toContain("Each step's full profile is in the appendix.");
  });

  it("names an unknown attribute in plain words instead of dropping it", async () => {
    const { json, workflow } = await claimsPartialFixture();
    const glance = section(renderBody(context(json, workflow)), "## How the workflow runs today");
    expect(glance).toContain("Not yet known: how long it takes.");
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
    expect(body).toMatch(/\*\*Rework loop\*\* — a cycle that keeps sending work back/);
    const shapes = section(body, "## Shapes worth attention");
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
    expect(body).toContain(`The top 2 in full. The remaining ${n - 2} are in the table above`);
    // Written up or not, EVERY opportunity has a row in the decision table.
    const table = section(body, "## Where to start");
    for (let rank = 1; rank <= n; rank++) expect(table).toContain(`| ${rank} | `);
    // The top one leads with its band and raw score, and quotes its
    // deterministic explanation verbatim in the audit block.
    const top = result.opportunities[0];
    expect(body).toContain(`**${scoreBand(top.score.total)} (${top.score.total}/100)**`);
    expect(body).toContain(top.explanation);
  });

  it("keeps the audit trail under every write-up, collapsed", async () => {
    const { json, workflow, result } = await reFixture();
    if (result.status !== "recommended") throw new Error(result.status);
    const body = renderBody(context(json, workflow, { top: 100 }));
    const rated = body.split("<summary>How this was rated, and how sure we are</summary>").length - 1;
    expect(rated).toBe(result.opportunities.length);
    // Every block that opens is closed — the two appendix blocks included.
    expect(body.split("<details>").length).toBe(body.split("</details>").length);
    expect(body.split("<details>").length - 1).toBe(result.opportunities.length + 2);
    // Every explanation and every confidence reason survives the collapse.
    for (const opp of result.opportunities) {
      expect(body).toContain(opp.explanation);
      for (const reason of opp.confidenceReasons) expect(body).toContain(`- ${reason}`);
    }
  });

  it("puts decisions before evidence: summary, table, write-ups, then the workings", async () => {
    const { json, workflow } = await reFixture();
    const ctx = context(json, workflow);
    const report = assembleReport(ctx, "## Summary\n\nx", renderBody(ctx));
    const order = [
      "# Improvement report",
      "## Summary",
      "## Where to start",
      "## The recommendations",
      "## How the workflow runs today",
      "## Appendix",
    ].map((h) => report.indexOf(h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > -1)).toBe(true);
  });

  it("bands every score and never prints a band without its number", async () => {
    const { json, workflow, result } = await reFixture();
    if (result.status !== "recommended") throw new Error(result.status);
    const body = renderBody(context(json, workflow, { top: 100 }));
    for (const opp of result.opportunities) {
      expect(body).toContain(`${scoreBand(opp.score.total)} (${opp.score.total}/100)`);
    }
    // The bands are a documented reading of the score, not a replacement.
    expect(body).toContain("**Rating bands** are a fixed reading of the 0–100 score");
    for (const band of SCORE_BANDS) expect(body).toContain(`“${band.label}”`);
    expect(scoreBand(35)).toBe("Strong candidate");
    expect(scoreBand(34)).toBe("Promising");
    expect(scoreBand(20)).toBe("Promising");
    expect(scoreBand(19)).toBe("Worth a look");
    expect(scoreBand(10)).toBe("Worth a look");
    expect(scoreBand(9)).toBe("Low priority");
    expect(scoreBand(0)).toBe("Low priority");
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
    expect(body).toContain(`*${variant.name}* — ${lowerFirst(variant.description)}`);
    if (variant.prerequisites.length > 0) expect(body).toContain(`You will need: ${variant.prerequisites.join("; ")}`);
    expect(body).toContain("**Confidence: medium**, because:");
    expect(eval_.confidenceReasons.length).toBeGreaterThan(0);
    for (const reason of eval_.confidenceReasons) expect(body).toContain(`- ${reason}`);
  });

  it("includes the appendix: score legend, one profile row per step, clarification history", async () => {
    const { json, workflow } = await reFixture();
    const body = renderBody(context(json, workflow));
    expect(body).toContain("### How this report was made");
    // The two reference blocks are audit material, so they collapse like the rest.
    expect(body).toContain("<summary>How to read the ratings</summary>");
    expect(body).toContain("<summary>The full step profiles</summary>");
    const rows = body.split("\n").filter((l) => /^\| (Collect|Distill|Expose|Agent|Verify)/.test(l));
    expect(rows).toHaveLength(5);
    expect(body).toContain("- No clarification rounds were run.");
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
    expect(body).toContain("The analysis stopped because the user ended clarification.");
    expect(body).toContain("1 question about the steps is still open");
    expect(body).toMatch(/1\. .*Is the claim complete\?/);
    expect(body).toContain("Not yet known: how long it takes.");
    expect(body).toContain("- duration unknown — scored at the lowest value (under 5 minutes)");
  });

  it("narrates skipped nodes, inherited questions, and which targets they touch", async () => {
    const { json, workflow } = await inheritedFixture();
    const body = renderBody(context(json, workflow));
    expect(body).toContain("1 node could not be analysed because the preprocessor left its type unknown: `mystery`.");
    expect(body).toContain("Questions still open about the workflow description itself");
    expect(body).toContain("- What happens after \"Enter the order into SAP\"? (`dead_end:a`)");
    expect(body).toContain("**Open questions from the preprocessor touch this target:** \"What happens after \\\"Enter the order into SAP\\\"?\" (`dead_end:a`)".replace(/\\"/g, '"'));
    expect(body).toContain("**Confidence: low**, because:");
    // Explicit-basis values carry no mark.
    expect(body).toContain("data entry,");
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
