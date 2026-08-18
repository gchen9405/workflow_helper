import { describe, expect, it } from "vitest";
import { detectGaps } from "../src/pipeline/gaps.js";
import { buildQuestions } from "../src/pipeline/questions.js";
import { edge, node, workflow } from "./helpers.js";

describe("buildQuestions", () => {
  it("orders structural blockers before the workflow name and caps the batch", () => {
    const wf = workflow({
      name: null,
      nodes: [node("a", { type: null, label: null }), node("b")],
      edges: [edge("e1", "a", "b")],
    });
    const gaps = detectGaps(wf);
    const questions = buildQuestions(wf, gaps, 2);
    expect(questions).toHaveLength(2);
    // missing_node_type ranks first; missing_workflow_name always last.
    expect(questions[0].id).toBe("missing_node_type:a");
    expect(questions.map((q) => q.id)).not.toContain("missing_workflow_name");
  });

  it("uses the question id as a stable link back to the gap", () => {
    const wf = workflow({ name: null, nodes: [], edges: [] });
    const questions = buildQuestions(wf, detectGaps(wf));
    for (const q of questions) {
      expect(q.id.length).toBeGreaterThan(0);
      expect(q.gap).toBeDefined();
    }
    // Same gaps -> same ids on a later round.
    const again = buildQuestions(wf, detectGaps(wf));
    expect(again.map((q) => q.id)).toEqual(questions.map((q) => q.id));
  });

  it("mentions node labels in question text when available", () => {
    const wf = workflow({
      nodes: [
        node("s", { type: "start", label: "Order received" }),
        node("pack", { type: null, label: "Pack order" }),
        node("e", { type: "end" }),
      ],
      edges: [edge("e1", "s", "pack"), edge("e2", "pack", "e")],
    });
    const questions = buildQuestions(wf, detectGaps(wf));
    const typeQuestion = questions.find((q) => q.id === "missing_node_type:pack");
    expect(typeQuestion?.text).toContain('"Pack order"');
    expect(typeQuestion?.text).toContain("(pack)");
  });

  it("asks open-ended first/last-step questions for an empty graph", () => {
    const wf = workflow({ nodes: [], edges: [] });
    const questions = buildQuestions(wf, detectGaps(wf));
    const texts = questions.map((q) => q.text).join(" ");
    expect(texts).toContain("first step");
    expect(texts).toContain("final step");
  });
});
