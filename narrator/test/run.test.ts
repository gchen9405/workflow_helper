/**
 * End-to-end orchestration with a stubbed LlmClient — no network. Covers
 * every terminal state the guarantee promises and every fallback trigger.
 */
import { describe, expect, it } from "vitest";
import { LlmHttpError, LlmRefusalError } from "workflow-preprocessor";
import { narrate } from "../src/pipeline/run.js";
import { FailingLlm, FakeLlm } from "./fakeLlm.js";
import { groundedSummaryFor, reFixture, unsuitableFixture } from "./fixtures.js";

describe("narrate — terminal states", () => {
  it("complete: a model summary on top of the deterministic body", async () => {
    const { json, workflow } = await reFixture();
    const llm = new FakeLlm({ summary: () => groundedSummaryFor(json) });
    const n = await narrate(llm, json, { workflow, workflowPath: "/x/re.json", inputLabel: "re.recommendations.json" });
    expect(n.status).toBe("complete");
    expect(n.summary?.kind).toBe("model");
    expect(llm.calls).toBe(1);
    expect(n.report.startsWith("# Improvement report — RE knowledge pipeline")).toBe(true);
    expect(n.report).toContain("## Summary\n\n_Written by the model");
    // The body the reader gets is byte-for-byte what the model was shown.
    expect(n.report).toContain(n.body);
    expect(n.report.indexOf("## Summary")).toBeLessThan(n.report.indexOf("## The workflow at a glance"));
    expect(n.report.endsWith("\n")).toBe(true);
    expect(n.source).toEqual({
      inputLabel: "re.recommendations.json",
      recommenderStatus: "recommended",
      workflowName: "RE knowledge pipeline",
      workflowPath: "/x/re.json",
    });
  });

  it("complete without a model: the deterministic summary, labelled as such", async () => {
    const { json, workflow } = await reFixture();
    const n = await narrate(null, json, { workflow });
    expect(n.status).toBe("complete");
    expect(n.summary?.kind).toBe("deterministic");
    if (n.summary?.kind !== "deterministic") return;
    expect(n.summary.reason).toBe("no model summary was requested");
    expect(n.report).toContain("_Written deterministically — no model summary was requested._");
    expect(n.report).toContain("## Recommendations");
  });

  it("fallback when the model declines", async () => {
    const { json, workflow } = await reFixture();
    const n = await narrate(new FailingLlm(new LlmRefusalError("summary")), json, { workflow });
    expect(n.status).toBe("fallback");
    if (n.summary?.kind !== "deterministic") throw new Error("expected deterministic");
    expect(n.summary.reason).toContain("declined");
    expect(n.report).toContain("## Recommendations"); // the body is never lost
  });

  it("fallback when the summary stays ungrounded through the repair loop", async () => {
    const { json, workflow } = await reFixture();
    const llm = new FakeLlm({ summary: () => ({ ...groundedSummaryFor(json), headline: "Score 777/100!" }) });
    const n = await narrate(llm, json, { workflow });
    expect(n.status).toBe("fallback");
    if (n.summary?.kind !== "deterministic") throw new Error("expected deterministic");
    expect(n.summary.reason).toContain("grounding check");
    expect(n.summary.reason).toContain("777/100");
  });

  it("fallback on endpoint errors, naming the HTTP status", async () => {
    const { json, workflow } = await reFixture();
    const n = await narrate(new FailingLlm(new LlmHttpError(503, "the LLM endpoint returned HTTP 503")), json, { workflow });
    expect(n.status).toBe("fallback");
    if (n.summary?.kind !== "deterministic") throw new Error("expected deterministic");
    expect(n.summary.reason).toContain("HTTP 503");
    const generic = await narrate(new FailingLlm(new Error("could not reach the LLM endpoint at x: ECONNREFUSED")), json, { workflow });
    expect(generic.status).toBe("fallback");
  });

  it("notice for an unsuitable result — no model call, no summary", async () => {
    const llm = new FakeLlm({ summary: () => { throw new Error("must not be called"); } });
    const n = await narrate(llm, unsuitableFixture(), { inputLabel: "bad.recommendations.json" });
    expect(n.status).toBe("notice");
    expect(n.summary).toBeNull();
    expect(llm.calls).toBe(0);
    expect(n.report).toContain("## Nothing to recommend on");
    expect(n.source.recommenderStatus).toBe("unsuitable");
  });

  it("rejects input that is not a recommender result", async () => {
    await expect(narrate(null, { nope: true })).rejects.toThrow(/not a recommender result/);
  });
});

describe("narrate — options", () => {
  it("honours `top`", async () => {
    const { json, workflow } = await reFixture();
    const one = await narrate(null, json, { workflow, top: 1 });
    expect(one.report).toContain("### 1. ");
    expect(one.report).not.toContain("### 2. ");
    expect(one.report).toContain("### Further opportunities");
    const all = await narrate(null, json, { workflow, top: 1000 });
    expect(all.report).not.toContain("### Further opportunities");
  });

  it("works without a workflow, using ids", async () => {
    const { json } = await reFixture();
    const n = await narrate(null, json);
    expect(n.report).toContain("step names unavailable");
    expect(n.report).toContain("step `verify`");
    expect(n.source.workflowPath).toBeNull();
  });
});
