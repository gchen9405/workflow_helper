/** The input boundary: envelope validation and defensive gap reading. */
import { describe, expect, it } from "vitest";
import { loadPreprocessResult, readGapNodeIds } from "../src/schema/input.js";
import { node, partialResult, validatedResult, workflow } from "./helpers.js";

describe("loadPreprocessResult", () => {
  it("loads a validated result with its workflow", () => {
    const wf = workflow({ nodes: [node("a")], provenance: { "node.a": "original" } });
    const loaded = loadPreprocessResult(validatedResult(wf));
    expect(loaded.status).toBe("validated");
    if (loaded.status !== "rejected") {
      expect(loaded.workflow.nodes[0].id).toBe("a");
      expect(loaded.workflow.provenance["node.a"]).toBe("original");
      expect(loaded.openQuestions).toEqual([]);
    }
  });

  it("loads a partial result with its open questions", () => {
    const wf = workflow({ nodes: [node("a", { type: null })] });
    const loaded = loadPreprocessResult(
      partialResult(wf, [
        { id: "missing_node_type:a", text: "What is a?", gap: { kind: "missing_node_type", nodeId: "a" } },
      ]),
    );
    expect(loaded.status).toBe("partial");
    if (loaded.status !== "rejected") {
      expect(loaded.openQuestions).toHaveLength(1);
      expect(loaded.openQuestions[0].id).toBe("missing_node_type:a");
    }
  });

  it("passes a rejected result through with its reason", () => {
    const loaded = loadPreprocessResult({ status: "rejected", reason: "not a workflow" });
    expect(loaded).toEqual({ status: "rejected", reason: "not a workflow" });
  });

  it("throws a readable error on non-result JSON", () => {
    expect(() => loadPreprocessResult({ hello: "world" })).toThrow(/not a preprocessor result/);
    expect(() => loadPreprocessResult(null)).toThrow(/not a preprocessor result/);
    expect(() => loadPreprocessResult("text")).toThrow(/not a preprocessor result/);
  });

  it("throws on malformed nodes/edges inside an otherwise valid envelope", () => {
    const wf = workflow({ nodes: [{ id: "a" }] as never });
    expect(() => loadPreprocessResult(validatedResult(wf))).toThrow(/node 0/);
  });
});

describe("readGapNodeIds", () => {
  it("reads nodeId and nodeIds shapes", () => {
    expect(readGapNodeIds({ kind: "missing_node_type", nodeId: "a" })).toEqual(["a"]);
    expect(readGapNodeIds({ kind: "exitless_cycle", nodeIds: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("yields [] on unknown shapes instead of failing", () => {
    expect(readGapNodeIds(null)).toEqual([]);
    expect(readGapNodeIds("x")).toEqual([]);
    expect(readGapNodeIds({ kind: "missing_workflow_name" })).toEqual([]);
    expect(readGapNodeIds({ nodeIds: [1, "b"] })).toEqual(["b"]);
  });
});
