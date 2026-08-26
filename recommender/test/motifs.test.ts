/** Each motif detector: firing rule, conservative non-firing, cycle safety. */
import { describe, expect, it } from "vitest";
import { detectMotifs } from "../src/pipeline/motifs.js";
import type { MotifKind } from "../src/schema/motif.js";
import { edge, node, profile, reKnowledgePipeline, reKnowledgeProfiles, workflow } from "./helpers.js";

function kinds(motifs: { kind: MotifKind }[]): MotifKind[] {
  return motifs.map((m) => m.kind);
}

describe("manual_data_transfer_chain", () => {
  const wf = workflow({
    nodes: [node("extract"), node("enter"), node("other_step")],
    edges: [edge("e1", "extract", "enter"), edge("e2", "enter", "other_step")],
  });

  it("fires on connected human data-handling steps, path-ordered", () => {
    const motifs = detectMotifs(wf, [
      profile("extract", { taskClass: "data_extraction" }),
      profile("enter", { taskClass: "data_entry" }),
      profile("other_step", { taskClass: "planning_analysis" }),
    ]);
    const chain = motifs.find((m) => m.kind === "manual_data_transfer_chain");
    expect(chain?.nodeIds).toEqual(["extract", "enter"]);
    expect(chain?.edgeIds).toEqual(["e1"]);
  });

  it("does not fire when the steps are system-performed or actor is unknown", () => {
    for (const actorKind of ["system", null] as const) {
      const motifs = detectMotifs(wf, [
        profile("extract", { taskClass: "data_extraction", actorKind }),
        profile("enter", { taskClass: "data_entry", actorKind }),
      ]);
      expect(kinds(motifs)).not.toContain("manual_data_transfer_chain");
    }
  });

  it("does not fire on disconnected data-handling steps", () => {
    const disconnected = workflow({
      nodes: [node("extract"), node("enter")],
      edges: [],
    });
    const motifs = detectMotifs(disconnected, [
      profile("extract", { taskClass: "data_extraction" }),
      profile("enter", { taskClass: "data_entry" }),
    ]);
    expect(kinds(motifs)).not.toContain("manual_data_transfer_chain");
  });
});

describe("approval_chain", () => {
  it("fires on two approvals within three hops and merges shared chains", () => {
    const wf = workflow({
      nodes: [node("ap1"), node("mid"), node("ap2")],
      edges: [edge("e1", "ap1", "mid"), edge("e2", "mid", "ap2")],
    });
    const motifs = detectMotifs(wf, [
      profile("ap1", { taskClass: "approval_decision" }),
      profile("mid", { taskClass: "data_entry" }),
      profile("ap2", { taskClass: "approval_decision" }),
    ]);
    const chain = motifs.find((m) => m.kind === "approval_chain");
    expect(chain?.nodeIds).toEqual(["ap1", "ap2"]);
  });

  it("does not fire when the approvals are more than three hops apart", () => {
    const wf = workflow({
      nodes: [node("ap1"), node("m1"), node("m2"), node("m3"), node("ap2")],
      edges: [
        edge("e1", "ap1", "m1"),
        edge("e2", "m1", "m2"),
        edge("e3", "m2", "m3"),
        edge("e4", "m3", "ap2"),
      ],
    });
    const motifs = detectMotifs(wf, [
      profile("ap1", { taskClass: "approval_decision" }),
      profile("m1", { taskClass: "data_entry" }),
      profile("m2", { taskClass: "data_entry" }),
      profile("m3", { taskClass: "data_entry" }),
      profile("ap2", { taskClass: "approval_decision" }),
    ]);
    expect(kinds(motifs)).not.toContain("approval_chain");
  });
});

describe("notification_tail", () => {
  it("fires when everything after a notification only notifies, files, or ends", () => {
    const wf = workflow({
      nodes: [node("work"), node("notify"), node("archive"), node("done", { type: "end" })],
      edges: [
        edge("e1", "work", "notify"),
        edge("e2", "notify", "archive"),
        edge("e3", "archive", "done"),
      ],
    });
    const motifs = detectMotifs(wf, [
      profile("work", { taskClass: "data_entry" }),
      profile("notify", { taskClass: "communication_notification" }),
      profile("archive", { taskClass: "archiving_records" }),
    ]);
    const tails = motifs.filter((m) => m.kind === "notification_tail");
    expect(tails).toHaveLength(1);
    expect(tails[0].nodeIds).toEqual(["notify", "archive", "done"]);
  });

  it("does not fire when real work follows the notification", () => {
    const wf = workflow({
      nodes: [node("notify"), node("work"), node("done", { type: "end" })],
      edges: [edge("e1", "notify", "work"), edge("e2", "work", "done")],
    });
    const motifs = detectMotifs(wf, [
      profile("notify", { taskClass: "communication_notification" }),
      profile("work", { taskClass: "data_entry" }),
    ]);
    expect(kinds(motifs)).not.toContain("notification_tail");
  });
});

describe("repeated_similar_tasks", () => {
  it("fires on same-class same-actor steps, adjacency not required", () => {
    const wf = workflow({
      nodes: [
        node("check1", { actor: "Ops" }),
        node("mid", { actor: "Ops" }),
        node("check2", { actor: "ops " }), // normalized: same actor
      ],
      edges: [edge("e1", "check1", "mid"), edge("e2", "mid", "check2")],
    });
    const motifs = detectMotifs(wf, [
      profile("check1", { taskClass: "verification_check" }),
      profile("mid", { taskClass: "planning_analysis" }),
      profile("check2", { taskClass: "verification_check" }),
    ]);
    const repeated = motifs.find((m) => m.kind === "repeated_similar_tasks");
    expect(repeated?.nodeIds).toEqual(["check1", "check2"]);
  });

  it("requires a named actor and skips other/physical classes", () => {
    const wf = workflow({ nodes: [node("a"), node("b")], edges: [] });
    expect(
      kinds(
        detectMotifs(wf, [
          profile("a", { taskClass: "verification_check" }), // actor null
          profile("b", { taskClass: "verification_check" }),
        ]),
      ),
    ).not.toContain("repeated_similar_tasks");

    const wf2 = workflow({
      nodes: [node("a", { actor: "X" }), node("b", { actor: "X" })],
      edges: [],
    });
    expect(
      kinds(
        detectMotifs(wf2, [
          profile("a", { taskClass: "other" }),
          profile("b", { taskClass: "other" }),
        ]),
      ),
    ).not.toContain("repeated_similar_tasks");
  });
});

describe("long_manual_chain", () => {
  it("fires on ≥3 unbranching same-actor human tasks and is maximal", () => {
    const wf = workflow({
      nodes: [node("a", { actor: "Sam" }), node("b", { actor: "Sam" }), node("c", { actor: "Sam" }), node("d", { type: "end" })],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "d")],
    });
    const motifs = detectMotifs(wf, [profile("a"), profile("b"), profile("c")]);
    const chains = motifs.filter((m) => m.kind === "long_manual_chain");
    expect(chains).toHaveLength(1);
    expect(chains[0].nodeIds).toEqual(["a", "b", "c"]);
    expect(chains[0].edgeIds).toEqual(["e1", "e2"]);
  });

  it("branching inside breaks the chain", () => {
    const wf = workflow({
      nodes: [node("a"), node("b"), node("c"), node("x")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "b", "x")],
    });
    const motifs = detectMotifs(wf, [profile("a"), profile("b"), profile("c"), profile("x")]);
    expect(kinds(motifs)).not.toContain("long_manual_chain");
  });

  it("terminates on a cycle of eligible nodes", () => {
    const wf = workflow({
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")],
    });
    const motifs = detectMotifs(wf, [profile("a"), profile("b"), profile("c")]);
    // Every node has a chain predecessor, so no maximal head exists — and
    // crucially the walk does not loop forever.
    expect(kinds(motifs)).not.toContain("long_manual_chain");
  });
});

describe("rework_loop", () => {
  it("fires on the RE pipeline's verify→distill cycle (the sample domain)", () => {
    const motifs = detectMotifs(reKnowledgePipeline(), reKnowledgeProfiles());
    const loops = motifs.filter((m) => m.kind === "rework_loop");
    expect(loops).toHaveLength(1);
    expect(loops[0].nodeIds).toEqual(["agent_assist", "distill", "expose", "verify"]);
    expect(loops[0].edgeIds).toEqual(expect.arrayContaining(["e3", "e4", "e5", "e7"]));
  });

  it("does not fire on a cycle without a review-class member", () => {
    const wf = workflow({
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "a")],
    });
    const motifs = detectMotifs(wf, [
      profile("a", { taskClass: "data_entry" }),
      profile("b", { taskClass: "data_entry" }),
    ]);
    expect(kinds(motifs)).not.toContain("rework_loop");
  });

  it("fires on a self-loop of a review step", () => {
    const wf = workflow({
      nodes: [node("review")],
      edges: [edge("e1", "review", "review")],
    });
    const motifs = detectMotifs(wf, [profile("review", { taskClass: "document_review" })]);
    expect(kinds(motifs)).toContain("rework_loop");
  });
});
