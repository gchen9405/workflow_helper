/** Shared builders for the unit tests of the deterministic core. */
import type { Workflow, WorkflowEdge, WorkflowNode } from "workflow-preprocessor";
import type { AttrValue, NodeProfile } from "../src/schema/profile.js";
import type {
  ActorKind,
  Duration,
  ErrorProneness,
  Frequency,
  Judgment,
  Sensitivity,
  Structure,
  TaskClass,
} from "../src/schema/taxonomy.js";
import type { InheritedQuestion } from "../src/schema/input.js";

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

/** A filled AttrValue (LLM-shaped: basis + evidence present) or a null one. */
export function attr<E>(value: E | null, basis: "explicit" | "implied" = "implied"): AttrValue<E> {
  return value === null
    ? { value: null, basis: null, evidence: null }
    : { value, basis, evidence: "test evidence" };
}

export interface ProfileOverrides {
  taskClass?: TaskClass | null;
  frequency?: Frequency | null;
  duration?: Duration | null;
  structure?: Structure | null;
  judgment?: Judgment | null;
  dataSensitivity?: Sensitivity | null;
  actorKind?: ActorKind | null;
  errorProneness?: ErrorProneness | null;
}

/** A fully known profile by default; override fields (null = unknown). */
export function profile(nodeId: string, over: ProfileOverrides = {}): NodeProfile {
  return {
    nodeId,
    taskClass: attr(over.taskClass !== undefined ? over.taskClass : "data_entry"),
    attributes: {
      frequency: attr(over.frequency !== undefined ? over.frequency : "daily"),
      duration: attr(over.duration !== undefined ? over.duration : "5_to_30_min"),
      structure: attr(over.structure !== undefined ? over.structure : "mostly_rules"),
      judgment: attr(over.judgment !== undefined ? over.judgment : "routine"),
      dataSensitivity: attr(
        over.dataSensitivity !== undefined ? over.dataSensitivity : "internal",
      ),
      actorKind: attr(over.actorKind !== undefined ? over.actorKind : "human"),
      errorProneness: attr(over.errorProneness !== undefined ? over.errorProneness : null),
    },
  };
}

/** A validated PreprocessResult envelope, as the preprocessor serializes it. */
export function validatedResult(wf: Workflow): unknown {
  return { status: "validated", schema: wf, intermediate: null, rounds: [] };
}

/** A partial PreprocessResult envelope with inherited open questions. */
export function partialResult(
  wf: Workflow,
  openQuestions: InheritedQuestion[] = [],
  reason = "the user ended clarification",
): unknown {
  return { status: "partial", schema: wf, openQuestions, reason, intermediate: null, rounds: [] };
}

/**
 * The user's sample domain: an RE-knowledge pipeline with a verify→distill
 * iteration cycle and an AI agent already performing one step.
 *
 *   s(start) → a collect → b distill → c expose → d agent-assist → e verify → f(end)
 *                            ↑__________________________________________|
 */
export function reKnowledgePipeline(): Workflow {
  return workflow({
    name: "RE knowledge pipeline",
    nodes: [
      node("s", { type: "start", label: "Start" }),
      node("collect", { label: "Collect RE knowledge sources: papers and existing tools" }),
      node("distill", { label: "Distill RE knowledge for AI-agent consumption" }),
      node("expose", { label: "Expose distilled knowledge to AI agent or custom harness" }),
      node("agent_assist", {
        label: "Agent assists with RE / software-understanding task",
        actor: "AI agent",
      }),
      node("verify", { label: "Verify with humans and/or benchmarks" }),
      node("f", { type: "end", label: "Actionable software-understanding output" }),
    ],
    edges: [
      edge("e1", "s", "collect"),
      edge("e2", "collect", "distill"),
      edge("e3", "distill", "expose"),
      edge("e4", "expose", "agent_assist"),
      edge("e5", "agent_assist", "verify"),
      edge("e6", "verify", "f", "accepted"),
      edge("e7", "verify", "distill", "needs iteration"),
    ],
  });
}

/** Complete profiles for the RE pipeline's five task nodes. */
export function reKnowledgeProfiles(): NodeProfile[] {
  return [
    profile("collect", {
      taskClass: "research_gathering",
      frequency: "weekly",
      duration: "30_min_to_2_h",
      structure: "guidelines_with_exceptions",
      judgment: "experienced",
    }),
    profile("distill", {
      taskClass: "knowledge_distillation",
      frequency: "weekly",
      duration: "2_h_to_1_day",
      structure: "guidelines_with_exceptions",
      judgment: "expert",
    }),
    profile("expose", {
      taskClass: "tool_integration",
      frequency: "monthly",
      duration: "30_min_to_2_h",
      structure: "mostly_rules",
      judgment: "experienced",
    }),
    profile("agent_assist", {
      taskClass: "document_review",
      frequency: "daily",
      duration: "30_min_to_2_h",
      structure: "guidelines_with_exceptions",
      judgment: "experienced",
      actorKind: "ai_agent",
    }),
    profile("verify", {
      taskClass: "evaluation_benchmarking",
      frequency: "daily",
      duration: "30_min_to_2_h",
      structure: "guidelines_with_exceptions",
      judgment: "experienced",
      errorProneness: "occasional",
    }),
  ];
}
