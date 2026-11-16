import { describe, expect, it } from "vitest";
import { detectGaps } from "../src/graph/gaps.js";
import { describeGap, listOpenGaps } from "../src/graph/describe.js";
import { edge, node, workflow } from "./helpers.js";

describe("listOpenGaps", () => {
  it("puts the brief before any structural gap", () => {
    const wf = workflow({
      problem: null,
      goal: null,
      task: { ...{ inputs: "tickets", inputShape: "structured", rulesSpecifiable: "mostly", variability: "medium", errorCost: "medium", frequency: null, auditability: null }, errorCost: null },
      profile: { technicalLevel: null, background: null, tools: [], notes: [] },
      nodes: [node("a", { type: null })],
      edges: [],
    });
    expect(listOpenGaps(wf).map((g) => g.id).slice(0, 5)).toEqual([
      "missing_problem",
      "missing_goal",
      "missing_task_fact:errorCost",
      "missing_technical_level",
      "missing_node_type:a",
    ]);
    expect(listOpenGaps(wf)[2].description).toContain("gets it wrong");
    expect(listOpenGaps(wf)[0].description).toContain("problem");
  });

  it("in brief scope, lists the idea to probe and nothing about completeness", () => {
    const wf = workflow({
      name: null,
      ideas: [{ id: "llm", summary: "let an LLM sort the reports", rationale: null, concerns: null }],
      nodes: [],
      edges: [],
    });
    const open = listOpenGaps(wf, "brief");
    expect(open.map((g) => g.id)).toEqual(["unexplored_idea:llm"]);
    expect(open[0].description).toContain('"let an LLM sort the reports"');
    expect(listOpenGaps(wf, "design").map((g) => g.id)).toContain("missing_workflow_name");
  });

  it("orders structural blockers before the workflow name", () => {
    const wf = workflow({
      name: null,
      nodes: [node("a", { type: null, label: null }), node("b")],
      edges: [edge("e1", "a", "b")],
    });
    const open = listOpenGaps(wf);
    // missing_node_type ranks first; missing_workflow_name always last.
    expect(open[0].id).toBe("missing_node_type:a");
    expect(open.at(-1)?.id).toBe("missing_workflow_name");
  });

  it("uses the gap id as a stable link back to the gap", () => {
    const wf = workflow({ name: null, nodes: [], edges: [] });
    const open = listOpenGaps(wf);
    expect(open.length).toBeGreaterThan(0);
    for (const g of open) {
      expect(g.id.length).toBeGreaterThan(0);
      expect(g.gap).toBeDefined();
      expect(g.description).toBe(describeGap(wf, g.gap));
    }
    // Same gaps -> same ids on a later turn.
    expect(listOpenGaps(wf).map((g) => g.id)).toEqual(open.map((g) => g.id));
  });

  it("accepts precomputed gaps and is empty for a complete workflow", () => {
    const wf = workflow({
      nodes: [node("s", { type: "start" }), node("e", { type: "end" })],
      edges: [edge("e1", "s", "e")],
    });
    expect(listOpenGaps(wf)).toEqual([]);
    expect(listOpenGaps(wf, "design", detectGaps(wf))).toEqual([]);
  });

  it("mentions node labels in descriptions when available", () => {
    const wf = workflow({
      nodes: [
        node("s", { type: "start", label: "Order received" }),
        node("pack", { type: null, label: "Pack order" }),
        node("e", { type: "end" }),
      ],
      edges: [edge("e1", "s", "pack"), edge("e2", "pack", "e")],
    });
    const typeGap = listOpenGaps(wf).find((g) => g.id === "missing_node_type:pack");
    expect(typeGap?.description).toContain('"Pack order"');
    expect(typeGap?.description).toContain("(pack)");
  });

  it("describes open-ended first/last-step gaps for an empty graph", () => {
    const wf = workflow({ nodes: [], edges: [] });
    const texts = listOpenGaps(wf).map((g) => g.description).join(" ");
    expect(texts).toContain("first step");
    expect(texts).toContain("final step");
  });
});
