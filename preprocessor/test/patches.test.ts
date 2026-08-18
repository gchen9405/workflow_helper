import { describe, expect, it } from "vitest";
import { applyPatches } from "../src/schema/patches.js";
import { completeWorkflow, edge, node, workflow } from "./helpers.js";

describe("applyPatches — provenance", () => {
  it("stamps user_elicited provenance on set fields", () => {
    const wf = completeWorkflow();
    const { workflow: next, errors, appliedCount } = applyPatches(wf, [
      { op: "set_workflow_field", field: "name", value: "Fulfillment v2" },
      { op: "set_node_field", nodeId: "a", field: "type", value: "task" },
      { op: "set_edge_label", edgeId: "e1", value: "submitted" },
    ]);
    expect(errors).toEqual([]);
    expect(appliedCount).toBe(3);
    expect(next.name).toBe("Fulfillment v2");
    expect(next.provenance["workflow.name"]).toBe("user_elicited");
    expect(next.provenance["node.a.type"]).toBe("user_elicited");
    expect(next.provenance["edge.e1.label"]).toBe("user_elicited");
  });

  it("stamps provenance for added nodes/edges: existence plus non-null fields only", () => {
    const wf = completeWorkflow();
    const { workflow: next, errors } = applyPatches(wf, [
      {
        op: "add_node",
        node: { id: "ship", type: "task", label: "Ship order", description: null, actor: null },
      },
      { op: "add_edge", edge: { id: "e7", from: "x", to: "ship", label: null } },
    ]);
    expect(errors).toEqual([]);
    expect(next.provenance["node.ship"]).toBe("user_elicited");
    expect(next.provenance["node.ship.type"]).toBe("user_elicited");
    expect(next.provenance["node.ship.label"]).toBe("user_elicited");
    expect(next.provenance["node.ship.description"]).toBeUndefined();
    expect(next.provenance["edge.e7"]).toBe("user_elicited");
    expect(next.provenance["edge.e7.label"]).toBeUndefined();
  });
});

describe("applyPatches — validation (feeds the machine repair loop)", () => {
  it("rejects a patch referencing a nonexistent node", () => {
    const wf = completeWorkflow();
    const { errors, appliedCount } = applyPatches(wf, [
      { op: "set_node_field", nodeId: "ghost", field: "label", value: "Boo" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"ghost"');
    expect(appliedCount).toBe(0);
  });

  it("rejects an added edge with a dangling endpoint", () => {
    const wf = completeWorkflow();
    const { workflow: next, errors } = applyPatches(wf, [
      { op: "add_edge", edge: { id: "e9", from: "x", to: "nowhere", label: null } },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"nowhere"');
    expect(next.edges).toHaveLength(wf.edges.length);
  });

  it("rejects an invalid node type value", () => {
    const wf = completeWorkflow();
    const { errors } = applyPatches(wf, [
      { op: "set_node_field", nodeId: "a", field: "type", value: "banana" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not a node type");
  });

  it("rejects duplicate ids on add", () => {
    const wf = completeWorkflow();
    const { errors } = applyPatches(wf, [
      { op: "add_node", node: node("a") },
      { op: "add_edge", edge: edge("e1", "s", "a") },
    ]);
    expect(errors).toHaveLength(2);
  });

  it("rejects empty values", () => {
    const wf = completeWorkflow();
    const { errors } = applyPatches(wf, [
      { op: "set_node_field", nodeId: "a", field: "label", value: "   " },
    ]);
    expect(errors).toHaveLength(1);
  });

  it("applies valid patches even when others in the list fail", () => {
    const wf = completeWorkflow();
    const { workflow: next, errors, appliedCount } = applyPatches(wf, [
      { op: "set_node_field", nodeId: "ghost", field: "label", value: "Boo" },
      { op: "set_workflow_field", field: "description", value: "Warehouse flow" },
    ]);
    expect(errors).toHaveLength(1);
    expect(appliedCount).toBe(1);
    expect(next.description).toBe("Warehouse flow");
  });
});

describe("applyPatches — ordering and removal", () => {
  it("lets later patches reference nodes created by earlier ones", () => {
    const wf = completeWorkflow();
    const { workflow: next, errors } = applyPatches(wf, [
      {
        op: "add_node",
        node: { id: "ship", type: "task", label: "Ship", description: null, actor: null },
      },
      { op: "add_edge", edge: { id: "e7", from: "x", to: "ship", label: null } },
      { op: "add_edge", edge: { id: "e8", from: "ship", to: "e", label: null } },
    ]);
    expect(errors).toEqual([]);
    expect(next.nodes.map((n) => n.id)).toContain("ship");
    expect(next.edges.map((e) => e.id)).toEqual(
      expect.arrayContaining(["e7", "e8"]),
    );
  });

  it("remove_node also removes incident edges and all related provenance", () => {
    const wf = workflow({
      nodes: [node("s", { type: "start" }), node("a"), node("e", { type: "end" })],
      edges: [edge("e1", "s", "a"), edge("e2", "a", "e")],
      provenance: {
        "node.a": "original",
        "node.a.label": "original",
        "edge.e1": "original",
        "edge.e2": "original",
      },
    });
    const { workflow: next, errors } = applyPatches(wf, [
      { op: "remove_node", nodeId: "a" },
    ]);
    expect(errors).toEqual([]);
    expect(next.nodes.map((n) => n.id)).toEqual(["s", "e"]);
    expect(next.edges).toEqual([]);
    expect(next.provenance["node.a"]).toBeUndefined();
    expect(next.provenance["node.a.label"]).toBeUndefined();
    expect(next.provenance["edge.e1"]).toBeUndefined();
    expect(next.provenance["edge.e2"]).toBeUndefined();
  });

  it("never mutates the input workflow", () => {
    const wf = completeWorkflow();
    const snapshot = JSON.parse(JSON.stringify(wf));
    applyPatches(wf, [
      { op: "set_workflow_field", field: "name", value: "Changed" },
      { op: "remove_node", nodeId: "a" },
    ]);
    expect(wf).toEqual(snapshot);
  });
});
