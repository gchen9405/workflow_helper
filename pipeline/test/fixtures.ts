/**
 * Canned model output for one small workflow — order fulfillment — shaped
 * like each stage's legal output (the FakeLlm parses every fixture through
 * the stage's real schema and semantic check).
 *
 *   s(start "Order received") → a "Validate order" → d(decision "In stock?")
 *     --yes--> x "Pick and pack" → e(end "Done")
 *     --no---> y "Backorder"     → e
 */
import type { ExtractionDraft } from "workflow-preprocessor";
import type { Duration, NodeProfile } from "workflow-recommender";
import { profileHandler, type Handler } from "./fakeLlm.js";

export const acceptTriage: Handler = () => ({ isWorkflow: true, reason: "describes a process" });
export const rejectTriage: Handler = () => ({
  isWorkflow: false,
  reason: "it is a quarterly revenue summary",
});
export const normalize: Handler = () => ({
  intermediate: "WORKFLOW: Order fulfillment\nNODES:\n- s [start] Order received\n…",
});

export function orderDraft(): ExtractionDraft {
  return {
    name: "Order fulfillment",
    description: null,
    nodes: [
      { id: "s", type: "start", label: "Order received", description: null, actor: null },
      { id: "a", type: "task", label: "Validate order", description: null, actor: "sales clerk" },
      { id: "d", type: "decision", label: "In stock?", description: null, actor: "warehouse system" },
      { id: "x", type: "task", label: "Pick and pack", description: null, actor: "warehouse staff" },
      { id: "y", type: "task", label: "Backorder", description: null, actor: "sales clerk" },
      { id: "e", type: "end", label: "Done", description: null, actor: null },
    ],
    edges: [
      { id: "e1", from: "s", to: "a", label: null },
      { id: "e2", from: "a", to: "d", label: null },
      { id: "e3", from: "d", to: "x", label: "yes" },
      { id: "e4", from: "d", to: "y", label: "no" },
      { id: "e5", from: "x", to: "e", label: null },
      { id: "e6", from: "y", to: "e", label: null },
    ],
  };
}

/** The same workflow with one label missing → one preprocessor gap. */
export function thinDraft(): ExtractionDraft {
  const draft = orderDraft();
  return {
    ...draft,
    nodes: draft.nodes.map((n) => (n.id === "a" ? { ...n, label: null } : n)),
  };
}

/** Answer application that fills the missing label with what the user said. */
export const fillLabel: Handler = () => ({
  patches: [{ op: "set_node_field", nodeId: "a", field: "label", value: "Validate order" }],
});

type Attr<E> = { value: E | null; basis: "explicit" | "implied" | null; evidence: string | null };
function attr<E>(value: E | null): Attr<E> {
  return value === null
    ? { value: null, basis: null, evidence: null }
    : { value, basis: "implied", evidence: "test evidence" };
}

function profile(
  nodeId: string,
  over: { taskClass?: NodeProfile["taskClass"]["value"]; duration?: Duration | null } = {},
): NodeProfile {
  return {
    nodeId,
    taskClass: attr(over.taskClass ?? "data_entry"),
    attributes: {
      frequency: attr("daily"),
      duration: attr(over.duration !== undefined ? over.duration : "5_to_30_min"),
      structure: attr("mostly_rules"),
      judgment: attr("routine"),
      dataSensitivity: attr("internal"),
      actorKind: attr("human"),
      errorProneness: attr(null),
    },
  };
}

/** Complete profiles for the four task/decision nodes. */
export function orderProfiles(over: { pickDuration?: Duration | null } = {}): NodeProfile[] {
  return [
    profile("a", { taskClass: "verification_check" }),
    profile("d", { taskClass: "verification_check" }),
    profile("x", { taskClass: "physical_task", duration: over.pickDuration }),
    profile("y", { taskClass: "data_entry" }),
  ];
}

export const profileOrder: Handler = profileHandler(
  Object.fromEntries(orderProfiles().map((p) => [p.nodeId, p])),
);

/** One attribute unknown → one recommender gap (a multiple-choice question). */
export const profileOrderThin: Handler = profileHandler(
  Object.fromEntries(orderProfiles({ pickDuration: null }).map((p) => [p.nodeId, p])),
);

/** A grounded summary: no scores cited, no ids, no headings, short. */
export const summary: Handler = () => ({
  headline: "Validating and backordering orders by hand is where the time goes.",
  overview:
    "Two steps stand out: validating each order and raising backorders are routine, daily, rule-driven work done by a person, which makes them good candidates for automation.\n\nMost values were inferred from the step wording, so treat the ratings as a starting point.",
  takeaways: ["Rule-based automation fits the routine steps.", "Confirm the inferred values before committing."],
  firstStep: "Write down the validation rules the sales clerk applies today, then script the checks.",
  caveats: ["Attribute values were inferred rather than stated."],
});

/** Handlers for a clean end-to-end run: validated → recommended → complete. */
export function happyHandlers(): Record<string, Handler> {
  return {
    triage: acceptTriage,
    normalization: normalize,
    extraction: () => orderDraft(),
    profiling: profileOrder,
    summary,
  };
}
