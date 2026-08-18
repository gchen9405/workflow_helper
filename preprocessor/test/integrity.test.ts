import { describe, expect, it } from "vitest";
import {
  stampOriginalProvenance,
  validateGraphIntegrity,
} from "../src/schema/workflow.js";
import { completeWorkflow, edge, node } from "./helpers.js";

describe("validateGraphIntegrity (machine-level repair input)", () => {
  it("accepts a valid graph", () => {
    expect(validateGraphIntegrity(completeWorkflow())).toEqual([]);
  });

  it("rejects duplicate node and edge ids", () => {
    const errors = validateGraphIntegrity({
      nodes: [node("a"), node("a")],
      edges: [edge("e1", "a", "a"), edge("e1", "a", "a")],
    });
    expect(errors).toContainEqual(expect.stringContaining('duplicate node id "a"'));
    expect(errors).toContainEqual(expect.stringContaining('duplicate edge id "e1"'));
  });

  it("rejects dangling edge endpoints", () => {
    const errors = validateGraphIntegrity({
      nodes: [node("a")],
      edges: [edge("e1", "a", "ghost")],
    });
    expect(errors).toContainEqual(expect.stringContaining('"ghost"'));
  });

  it("rejects empty ids", () => {
    const errors = validateGraphIntegrity({
      nodes: [node("")],
      edges: [edge(" ", "a", "b")],
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("stampOriginalProvenance", () => {
  it("marks every filled field and entity as original, and nothing else", () => {
    const wf = stampOriginalProvenance({
      name: "Flow",
      description: null,
      nodes: [
        {
          id: "a",
          type: "start",
          label: null,
          description: null,
          actor: "HR",
        },
      ],
      edges: [{ id: "e1", from: "a", to: "a", label: null }],
    });
    expect(wf.provenance).toEqual({
      "workflow.name": "original",
      "node.a": "original",
      "node.a.type": "original",
      "node.a.actor": "original",
      "edge.e1": "original",
    });
  });
});
