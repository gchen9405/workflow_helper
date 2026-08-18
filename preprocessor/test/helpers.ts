/** Shared builders for the unit tests of the deterministic core. */
import type {
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from "../src/schema/workflow.js";

export function node(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: "task", label: id, description: null, actor: null, ...over };
}

export function edge(
  id: string,
  from: string,
  to: string,
  label: string | null = null,
): WorkflowEdge {
  return { id, from, to, label };
}

export function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    name: "Test workflow",
    description: null,
    nodes: [],
    edges: [],
    provenance: {},
    ...over,
  };
}

/**
 * A complete workflow with a branch that reconverges:
 *
 *   s(start) -> a -> d(decision) --yes--> x -> e(end)
 *                              \--no---> y -> e
 */
export function completeWorkflow(): Workflow {
  return workflow({
    name: "Order fulfillment",
    nodes: [
      node("s", { type: "start", label: "Order received" }),
      node("a", { label: "Validate order" }),
      node("d", { type: "decision", label: "In stock?" }),
      node("x", { label: "Pick and pack" }),
      node("y", { label: "Backorder" }),
      node("e", { type: "end", label: "Done" }),
    ],
    edges: [
      edge("e1", "s", "a"),
      edge("e2", "a", "d"),
      edge("e3", "d", "x", "yes"),
      edge("e4", "d", "y", "no"),
      edge("e5", "x", "e"),
      edge("e6", "y", "e"),
    ],
  });
}
