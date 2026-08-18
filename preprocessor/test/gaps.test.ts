import { describe, expect, it } from "vitest";
import { detectGaps, gapId, type Gap } from "../src/pipeline/gaps.js";
import { completeWorkflow, edge, node, workflow } from "./helpers.js";

const kinds = (gaps: Gap[]): string[] => gaps.map((g) => g.kind);

describe("detectGaps — completeness (the termination condition)", () => {
  it("returns no gaps for a complete workflow with a reconverging branch", () => {
    expect(detectGaps(completeWorkflow())).toEqual([]);
  });

  it("does not flag single unlabeled 'next' edges or null description/actor", () => {
    // Non-branching null edge labels and optional enrichment fields are not gaps.
    const wf = workflow({
      nodes: [
        node("s", { type: "start", description: null, actor: null }),
        node("e", { type: "end" }),
      ],
      edges: [edge("e1", "s", "e", null)],
    });
    expect(detectGaps(wf)).toEqual([]);
  });

  it("allows a cycle that has an exit to an end node", () => {
    const wf = workflow({
      nodes: [
        node("s", { type: "start" }),
        node("a"),
        node("b", { type: "decision" }),
        node("e", { type: "end" }),
      ],
      edges: [
        edge("e1", "s", "a"),
        edge("e2", "a", "b"),
        edge("e3", "b", "a", "retry"),
        edge("e4", "b", "e", "done"),
      ],
    });
    expect(detectGaps(wf)).toEqual([]);
  });
});

describe("detectGaps — missing fields", () => {
  it("flags a null workflow name", () => {
    const wf = completeWorkflow();
    wf.name = null;
    expect(detectGaps(wf)).toEqual([{ kind: "missing_workflow_name" }]);
  });

  it("flags null node types and labels per node", () => {
    const wf = completeWorkflow();
    wf.nodes[1] = node("a", { type: null, label: null });
    const gaps = detectGaps(wf);
    expect(gaps).toContainEqual({ kind: "missing_node_type", nodeId: "a" });
    expect(gaps).toContainEqual({ kind: "missing_node_label", nodeId: "a" });
  });
});

describe("detectGaps — start and end nodes", () => {
  it("flags a missing start node when all types are known", () => {
    const wf = workflow({
      nodes: [node("a"), node("e", { type: "end" })],
      edges: [edge("e1", "a", "e")],
    });
    expect(kinds(detectGaps(wf))).toContain("no_start_node");
  });

  it("flags a missing end node when all types are known", () => {
    const wf = workflow({
      nodes: [node("s", { type: "start" }), node("a")],
      edges: [edge("e1", "s", "a")],
    });
    const gaps = detectGaps(wf);
    expect(kinds(gaps)).toContain("no_end_node");
    // ...and the non-end sink is also a dead end.
    expect(gaps).toContainEqual({ kind: "dead_end", nodeId: "a" });
  });

  it("suppresses no_start/no_end while some node type is unknown", () => {
    // Answering the type question may reveal the start/end — asking both in
    // one round would be redundant.
    const wf = workflow({
      nodes: [node("a", { type: null }), node("b")],
      edges: [edge("e1", "a", "b")],
    });
    const found = kinds(detectGaps(wf));
    expect(found).toContain("missing_node_type");
    expect(found).not.toContain("no_start_node");
    expect(found).not.toContain("no_end_node");
  });

  it("flags both on an empty graph (thin input)", () => {
    const wf = workflow({ nodes: [], edges: [] });
    const found = kinds(detectGaps(wf));
    expect(found).toContain("no_start_node");
    expect(found).toContain("no_end_node");
  });
});

describe("detectGaps — structure", () => {
  it("flags nodes unreachable from any start node", () => {
    const wf = workflow({
      nodes: [
        node("s", { type: "start" }),
        node("e", { type: "end" }),
        node("orphan"),
        node("orphan2", { type: "end" }),
      ],
      edges: [edge("e1", "s", "e"), edge("e2", "orphan", "orphan2")],
    });
    expect(detectGaps(wf)).toContainEqual({
      kind: "unreachable_nodes",
      nodeIds: ["orphan", "orphan2"],
    });
  });

  it("flags a non-end node with no outgoing edges as a dead end", () => {
    const wf = workflow({
      nodes: [node("s", { type: "start" }), node("a"), node("e", { type: "end" })],
      edges: [edge("e1", "s", "a"), edge("e2", "s", "e", "shortcut")],
    });
    expect(detectGaps(wf)).toContainEqual({ kind: "dead_end", nodeId: "a" });
  });

  it("does not flag a dead end for a node whose type is still unknown", () => {
    // The missing_node_type question resolves it first; if the user says
    // "end" there was never a dead end.
    const wf = workflow({
      nodes: [node("s", { type: "start" }), node("a", { type: null })],
      edges: [edge("e1", "s", "a")],
    });
    expect(kinds(detectGaps(wf))).not.toContain("dead_end");
  });

  it("flags unlabeled edges on a branching node, listing the unlabeled edge ids", () => {
    const wf = workflow({
      nodes: [
        node("s", { type: "start" }),
        node("d", { type: "decision" }),
        node("x"),
        node("y"),
        node("e", { type: "end" }),
      ],
      edges: [
        edge("e1", "s", "d"),
        edge("e2", "d", "x", "yes"),
        edge("e3", "d", "y", null), // unlabeled branch
        edge("e4", "x", "e"),
        edge("e5", "y", "e"),
      ],
    });
    expect(detectGaps(wf)).toContainEqual({
      kind: "unlabeled_branch",
      nodeId: "d",
      edgeIds: ["e3"],
    });
  });

  it("flags a cycle with no path to any end node", () => {
    const wf = workflow({
      nodes: [
        node("s", { type: "start", label: "Start" }),
        node("a", { label: "Work" }),
        node("b", { type: "decision", label: "Again?" }),
        node("e", { type: "end", label: "Done" }),
      ],
      edges: [
        edge("e1", "s", "a"),
        edge("e2", "a", "b"),
        edge("e3", "b", "a", "loop"),
        edge("e4", "s", "e", "skip"),
      ],
    });
    expect(detectGaps(wf)).toContainEqual({
      kind: "exitless_cycle",
      nodeIds: ["a", "b"],
    });
  });

  it("flags a self-loop with no exit as an exitless cycle", () => {
    const wf = workflow({
      nodes: [
        node("s", { type: "start" }),
        node("a"),
        node("e", { type: "end" }),
      ],
      edges: [
        edge("e1", "s", "a"),
        edge("e2", "a", "a", "again"),
        edge("e3", "s", "e", "skip"),
      ],
    });
    expect(detectGaps(wf)).toContainEqual({
      kind: "exitless_cycle",
      nodeIds: ["a"],
    });
  });

  it("suppresses the cycle check while no end node exists", () => {
    // no_end_node already covers this situation.
    const wf = workflow({
      nodes: [node("s", { type: "start" }), node("a"), node("b")],
      edges: [edge("e1", "s", "a"), edge("e2", "a", "b"), edge("e3", "b", "a", "loop")],
    });
    const found = kinds(detectGaps(wf));
    expect(found).toContain("no_end_node");
    expect(found).not.toContain("exitless_cycle");
  });
});

describe("gapId", () => {
  it("is stable and unique per gap target", () => {
    const a: Gap = { kind: "missing_node_type", nodeId: "a" };
    const b: Gap = { kind: "missing_node_type", nodeId: "b" };
    expect(gapId(a)).toBe("missing_node_type:a");
    expect(gapId(a)).toBe(gapId({ kind: "missing_node_type", nodeId: "a" }));
    expect(gapId(a)).not.toBe(gapId(b));
  });

  it("sorts node ids so the id does not depend on detection order", () => {
    expect(gapId({ kind: "exitless_cycle", nodeIds: ["b", "a"] })).toBe(
      gapId({ kind: "exitless_cycle", nodeIds: ["a", "b"] }),
    );
  });
});
