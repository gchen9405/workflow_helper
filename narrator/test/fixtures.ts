/**
 * Recommender results to narrate, produced by running the REAL recommender
 * pipeline (deterministic core + a stubbed profiling call) over small
 * workflows, then round-tripped through JSON exactly as a file would be.
 * The narrator is therefore tested against genuine recommender output, not
 * hand-written approximations of it.
 */
import { silentIO, type Workflow, type WorkflowEdge, type WorkflowNode } from "workflow-preprocessor";
import { runRecommender, type NodeProfile, type RecommendationResult } from "workflow-recommender";
import type {
  ActorKind,
  Duration,
  ErrorProneness,
  Frequency,
  Judgment,
  Sensitivity,
  Structure,
  TaskClass,
} from "workflow-recommender";
import { FakeLlm, profileHandler } from "./fakeLlm.js";

export function node(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: "task", label: id, description: null, actor: null, ...over };
}

export function edge(id: string, from: string, to: string, label: string | null = null): WorkflowEdge {
  return { id, from, to, label };
}

export function workflow(over: Partial<Workflow> = {}): Workflow {
  return { name: "Test workflow", description: null, nodes: [], edges: [], provenance: {}, ...over };
}

type Attr<E> = { value: E | null; basis: "explicit" | "implied" | null; evidence: string | null };
function attr<E>(value: E | null, basis: "explicit" | "implied" = "implied"): Attr<E> {
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
  /** Basis for every filled value (explicit → "original" provenance). */
  basis?: "explicit" | "implied";
}

/** A fully known profile by default; override fields (null = unknown). */
export function profile(nodeId: string, over: ProfileOverrides = {}): NodeProfile {
  const b = over.basis ?? "implied";
  const pick = <T>(v: T | null | undefined, d: T | null): T | null => (v !== undefined ? v : d);
  return {
    nodeId,
    taskClass: attr(pick(over.taskClass, "data_entry"), b),
    attributes: {
      frequency: attr(pick(over.frequency, "daily"), b),
      duration: attr(pick(over.duration, "5_to_30_min"), b),
      structure: attr(pick(over.structure, "mostly_rules"), b),
      judgment: attr(pick(over.judgment, "routine"), b),
      dataSensitivity: attr(pick(over.dataSensitivity, "internal"), b),
      actorKind: attr(pick(over.actorKind, "human"), b),
      errorProneness: attr(pick(over.errorProneness, null), b),
    },
  };
}

export function validatedResult(wf: Workflow): unknown {
  return { status: "validated", schema: wf, intermediate: null, rounds: [] };
}

export function partialPreprocessResult(
  wf: Workflow,
  openQuestions: { id: string; text: string; gap: unknown }[],
  reason = "the user ended clarification",
): unknown {
  return { status: "partial", schema: wf, openQuestions, reason, intermediate: null, rounds: [] };
}

/** File round trip: what the narrator actually reads. */
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

async function recommend(input: unknown, profiles: NodeProfile[]): Promise<RecommendationResult> {
  const byId = Object.fromEntries(profiles.map((p) => [p.nodeId, p]));
  const llm = new FakeLlm({ profiling: profileHandler(byId) });
  return runRecommender(llm, input, silentIO, { sourcePath: "/tmp/does-not-exist.json" });
}

// ---------------------------------------------------------------------------
// The RE knowledge pipeline — the project's sample domain
// ---------------------------------------------------------------------------

export function reKnowledgePipeline(): Workflow {
  return workflow({
    name: "RE knowledge pipeline",
    nodes: [
      node("s", { type: "start", label: "Start" }),
      node("collect", { label: "Collect RE knowledge sources: papers and existing tools" }),
      node("distill", { label: "Distill RE knowledge for AI-agent consumption" }),
      node("expose", { label: "Expose distilled knowledge to AI agent or custom harness" }),
      node("agent_assist", { label: "Agent assists with RE / software-understanding task", actor: "AI agent" }),
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
      basis: "explicit",
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

/** A `recommended` result over the RE pipeline (no gaps → zero rounds). */
export async function reFixture(): Promise<{ json: unknown; workflow: Workflow; result: RecommendationResult }> {
  const wf = reKnowledgePipeline();
  const result = await recommend(validatedResult(wf), reKnowledgeProfiles());
  return { json: roundTrip(result), workflow: wf, result };
}

// ---------------------------------------------------------------------------
// A claims-intake flow: regulated data, a sequence, an exclusion, a gap
// ---------------------------------------------------------------------------

export function claimsIntake(): Workflow {
  return workflow({
    name: "Claims intake",
    description: "How new insurance claims get from the inbox to a decision.",
    nodes: [
      node("s", { type: "start", label: "Start" }),
      node("watch", { label: "Watch the shared inbox for new claims", actor: "claims clerk" }),
      node("extract", { label: "Extract claim details from the submitted forms", actor: "claims clerk" }),
      node("complete", { type: "decision", label: "Is the claim complete?", actor: "claims clerk" }),
      node("notify", { label: "Notify the claimant of the outcome", actor: "claims clerk" }),
      node("z", { type: "end", label: "End" }),
    ],
    edges: [
      edge("e1", "s", "watch"),
      edge("e2", "watch", "extract"),
      edge("e3", "extract", "complete"),
      edge("e4", "complete", "notify", "yes"),
      edge("e5", "complete", "watch", "no — wait for more documents"),
      edge("e6", "notify", "z"),
    ],
  });
}

export function claimsProfiles(over: { completeDuration?: Duration | null } = {}): NodeProfile[] {
  const regulated = { dataSensitivity: "regulated" as const };
  return [
    profile("watch", {
      ...regulated,
      taskClass: "monitoring_watching",
      frequency: "many_per_day",
      duration: "under_5_min",
      structure: "mostly_rules",
      judgment: "routine",
    }),
    profile("extract", {
      ...regulated,
      taskClass: "data_extraction",
      frequency: "daily",
      duration: "5_to_30_min",
      structure: "guidelines_with_exceptions",
      judgment: "routine",
      errorProneness: "occasional",
    }),
    profile("complete", {
      ...regulated,
      taskClass: "verification_check",
      frequency: "daily",
      duration: over.completeDuration !== undefined ? over.completeDuration : "under_5_min",
      structure: "mostly_rules",
      judgment: "routine",
    }),
    profile("notify", {
      ...regulated,
      taskClass: "communication_notification",
      frequency: "daily",
      duration: "under_5_min",
      structure: "fully_rule_based",
      judgment: "none",
    }),
  ];
}

/** A `recommended` claims result: sequences + sensitivity exclusions. */
export async function claimsFixture(): Promise<{ json: unknown; workflow: Workflow; result: RecommendationResult }> {
  const wf = claimsIntake();
  const result = await recommend(validatedResult(wf), claimsProfiles());
  return { json: roundTrip(result), workflow: wf, result };
}

/** A `partial` claims result: one duration unknown, silent IO → open question. */
export async function claimsPartialFixture(): Promise<{ json: unknown; workflow: Workflow; result: RecommendationResult }> {
  const wf = claimsIntake();
  const result = await recommend(validatedResult(wf), claimsProfiles({ completeDuration: null }));
  return { json: roundTrip(result), workflow: wf, result };
}

// ---------------------------------------------------------------------------
// A partial PREPROCESSOR input: skipped node + inherited open questions
// ---------------------------------------------------------------------------

export async function inheritedFixture(): Promise<{ json: unknown; workflow: Workflow; result: RecommendationResult }> {
  const wf = workflow({
    name: "Order entry",
    nodes: [
      node("s", { type: "start", label: "Start" }),
      node("a", { label: "Enter the order into SAP" }),
      node("mystery", { type: null, label: "Something happens" }),
      node("z", { type: "end", label: "End" }),
    ],
    edges: [edge("e1", "s", "a"), edge("e2", "a", "mystery"), edge("e3", "mystery", "z")],
  });
  const inherited = [
    {
      id: "missing_node_type:mystery",
      text: "What kind of step is \"Something happens\"?",
      gap: { kind: "missing_node_type", nodeId: "mystery" },
    },
    { id: "dead_end:a", text: "What happens after \"Enter the order into SAP\"?", gap: { kind: "dead_end", nodeId: "a" } },
  ];
  const result = await recommend(partialPreprocessResult(wf, inherited), [profile("a", { basis: "explicit" })]);
  return { json: roundTrip(result), workflow: wf, result };
}

export function unsuitableFixture(reason = "the preprocessor rejected this input: it is a financial summary, not a workflow"): unknown {
  return { status: "unsuitable", reason };
}

// ---------------------------------------------------------------------------
// Model summaries
// ---------------------------------------------------------------------------

/** A grounded summary for any result: cites only the top score, no ids. */
export function groundedSummaryFor(json: unknown) {
  const result = json as { opportunities?: { score: { total: number } }[]; workflowName?: string | null };
  const top = result.opportunities?.[0]?.score.total;
  return {
    headline: `The biggest wins for "${result.workflowName ?? "the workflow"}" are automation of the verification step and better knowledge tooling.`,
    overview:
      `The report ranks ${result.opportunities?.length ?? 0} opportunities.` +
      (top !== undefined ? ` The top one scores ${top}/100.` : "") +
      "\n\nMost values were inferred from the step wording, so confidence is medium at best.",
    takeaways: ["Start with the top-ranked recommendation.", "Confidence is limited by inferred values."],
    firstStep: "Set up the top-ranked recommendation's lowest-effort deployment option after confirming its prerequisites.",
    caveats: ["Several attribute values were inferred rather than stated."],
  };
}
