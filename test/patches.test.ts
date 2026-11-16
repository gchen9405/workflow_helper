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

describe("applyPatches — the brief and provenance source", () => {
  it("sets problem and goal, and records constraints with per-entry provenance", () => {
    const wf = workflow({ problem: null, goal: null });
    const { workflow: next, errors, appliedCount } = applyPatches(wf, [
      { op: "set_workflow_field", field: "problem", value: "Reports get lost" },
      { op: "set_workflow_field", field: "goal", value: "Every report has an owner" },
      { op: "add_constraint", value: "No external SaaS" },
      { op: "add_constraint", value: "Three developers" },
    ]);
    expect(errors).toEqual([]);
    expect(appliedCount).toBe(4);
    expect(next.problem).toBe("Reports get lost");
    expect(next.goal).toBe("Every report has an owner");
    expect(next.constraints).toEqual(["No external SaaS", "Three developers"]);
    expect(next.provenance["workflow.problem"]).toBe("user_elicited");
    expect(next.provenance["constraint.0"]).toBe("user_elicited");
    expect(next.provenance["constraint.1"]).toBe("user_elicited");
  });

  it("records task facts, validating enum fields per field", () => {
    const wf = workflow({ task: { inputs: null, inputShape: null, rulesSpecifiable: null, variability: null, errorCost: null, frequency: null, auditability: null } });
    const { workflow: next, errors, appliedCount } = applyPatches(wf, [
      { op: "set_task_field", field: "inputs", value: "bug reports from email and chat" },
      { op: "set_task_field", field: "inputShape", value: "unstructured" },
      { op: "set_task_field", field: "rulesSpecifiable", value: "partly" },
      { op: "set_task_field", field: "errorCost", value: "huge" },
      { op: "set_task_field", field: "variability", value: " " },
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("errorCost");
    expect(appliedCount).toBe(3);
    expect(next.task.inputs).toBe("bug reports from email and chat");
    expect(next.task.inputShape).toBe("unstructured");
    expect(next.task.rulesSpecifiable).toBe("partly");
    expect(next.task.errorCost).toBeNull();
    expect(next.provenance["task.inputs"]).toBe("user_elicited");
    expect(next.provenance["task.inputShape"]).toBe("user_elicited");
    expect(next.provenance["task.errorCost"]).toBeUndefined();
  });

  it("records the profile: level, background, tools (updated in place), notes", () => {
    const wf = workflow({ profile: { technicalLevel: null, background: null, tools: [], notes: [] } });
    const { workflow: next, errors, appliedCount } = applyPatches(wf, [
      { op: "set_technical_level", value: "basic" },
      { op: "set_background", value: "Lab manager in a chemistry group" },
      { op: "set_tool_familiarity", name: "Excel", familiarity: "fluent" },
      { op: "set_tool_familiarity", name: "Python", familiarity: "unfamiliar" },
      { op: "set_tool_familiarity", name: "excel", familiarity: "basic" }, // update, not duplicate
      { op: "add_profile_note", value: "Would rather not maintain scripts" },
    ]);
    expect(errors).toEqual([]);
    expect(appliedCount).toBe(6);
    expect(next.profile.technicalLevel).toBe("basic");
    expect(next.profile.background).toBe("Lab manager in a chemistry group");
    expect(next.profile.tools).toEqual([
      { name: "Excel", familiarity: "basic" },
      { name: "Python", familiarity: "unfamiliar" },
    ]);
    expect(next.profile.notes).toEqual(["Would rather not maintain scripts"]);
    expect(next.provenance["profile.technicalLevel"]).toBe("user_elicited");
    expect(next.provenance["profile.background"]).toBe("user_elicited");
    expect(next.provenance["profile.tool.excel"]).toBe("user_elicited");
    expect(next.provenance["profile.tool.python"]).toBe("user_elicited");
    expect(next.provenance["profile.note.0"]).toBe("user_elicited");
  });

  it("rejects an empty tool name, an empty background, and a duplicate note", () => {
    const wf = workflow({ profile: { technicalLevel: null, background: null, tools: [], notes: ["Busy"] } });
    const { errors, appliedCount } = applyPatches(wf, [
      { op: "set_tool_familiarity", name: " ", familiarity: "basic" },
      { op: "set_background", value: "" },
      { op: "add_profile_note", value: "busy" },
    ]);
    expect(errors).toHaveLength(3);
    expect(appliedCount).toBe(0);
  });

  it("records ideas, fills their reasoning, and drops them with their provenance", () => {
    const wf = workflow({ ideas: [] });
    const { workflow: next, errors, appliedCount } = applyPatches(wf, [
      { op: "add_idea", idea: { id: "llm", summary: "an LLM sorts reports", rationale: null, concerns: "cost" } },
      { op: "set_idea_field", ideaId: "llm", field: "rationale", value: "it reads free text well" },
      { op: "add_idea", idea: { id: "vote", summary: "a weekly vote", rationale: null, concerns: null } },
      { op: "remove_idea", ideaId: "vote" },
    ]);
    expect(errors).toEqual([]);
    expect(appliedCount).toBe(4);
    expect(next.ideas).toEqual([
      { id: "llm", summary: "an LLM sorts reports", rationale: "it reads free text well", concerns: "cost" },
    ]);
    expect(next.provenance["idea.llm"]).toBe("user_elicited");
    expect(next.provenance["idea.llm.rationale"]).toBe("user_elicited");
    expect(next.provenance["idea.llm.concerns"]).toBe("user_elicited");
    expect(next.provenance["idea.vote"]).toBeUndefined();
  });

  it("rejects a duplicate idea id, an unknown idea, and an empty idea value", () => {
    const wf = workflow({ ideas: [{ id: "llm", summary: "x", rationale: null, concerns: null }] });
    const { errors, appliedCount } = applyPatches(wf, [
      { op: "add_idea", idea: { id: "llm", summary: "again", rationale: null, concerns: null } },
      { op: "set_idea_field", ideaId: "ghost", field: "rationale", value: "y" },
      { op: "set_idea_field", ideaId: "llm", field: "rationale", value: " " },
      { op: "remove_idea", ideaId: "ghost" },
    ]);
    expect(errors).toHaveLength(4);
    expect(appliedCount).toBe(0);
  });

  it("rejects a duplicate constraint (case-insensitively) and an empty one", () => {
    const wf = workflow({ constraints: ["No external SaaS"] });
    const { errors, appliedCount } = applyPatches(wf, [
      { op: "add_constraint", value: "no external saas" },
      { op: "add_constraint", value: "  " },
    ]);
    expect(errors).toHaveLength(2);
    expect(appliedCount).toBe(0);
  });

  it("stamps the given source, so accepted proposals read agent_proposed", () => {
    const wf = completeWorkflow();
    const { workflow: next } = applyPatches(
      wf,
      [
        { op: "set_workflow_field", field: "goal", value: "Faster" },
        { op: "add_node", node: { id: "ship", type: "task", label: "Ship", description: null, actor: null } },
        { op: "add_constraint", value: "Within a day" },
      ],
      "agent_proposed",
    );
    expect(next.provenance["workflow.goal"]).toBe("agent_proposed");
    expect(next.provenance["node.ship"]).toBe("agent_proposed");
    expect(next.provenance["node.ship.label"]).toBe("agent_proposed");
    expect(next.provenance["constraint.0"]).toBe("agent_proposed");
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
