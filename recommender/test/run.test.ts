/**
 * End-to-end orchestration with a stubbed LlmClient — no network.
 * Covers every terminal state the guarantee promises, every `partial`
 * trigger, and the sample-domain expectations (RE knowledge pipeline).
 */
import { describe, expect, it } from "vitest";
import type { BatchAnswers } from "workflow-preprocessor";
import { runRecommender } from "../src/pipeline/run.js";
import type { ProfileQuestion } from "../src/pipeline/questions.js";
import { FakeLlm, profileHandler } from "./fakeLlm.js";
import {
  edge,
  node,
  partialResult,
  profile,
  reKnowledgePipeline,
  reKnowledgeProfiles,
  validatedResult,
  workflow,
} from "./helpers.js";

/** Scripted IO that records every batch it was shown. */
function scriptedIO(...batches: BatchAnswers[]) {
  const state = {
    seen: [] as ProfileQuestion[][],
    async askBatch(questions: ProfileQuestion[]): Promise<BatchAnswers> {
      state.seen.push(questions);
      return batches[state.seen.length - 1] ?? { stopped: true, answers: [] };
    },
  };
  return state;
}

const neverAsk = {
  askBatch: (): Promise<BatchAnswers> => {
    throw new Error("clarification should not have been needed");
  },
};

/** start → a → end, with `a` the only profiled node. */
function tinyWorkflow() {
  return workflow({
    nodes: [node("s", { type: "start" }), node("a", { label: "Enter data" }), node("z", { type: "end" })],
    edges: [edge("e1", "s", "a"), edge("e2", "a", "z")],
  });
}

describe("runRecommender — terminal states", () => {
  it("maps a rejected preprocessor result to unsuitable", async () => {
    const result = await runRecommender(
      new FakeLlm({}),
      { status: "rejected", reason: "it is a financial summary" },
      neverAsk,
    );
    expect(result.status).toBe("unsuitable");
    if (result.status === "unsuitable") {
      expect(result.reason).toContain("financial summary");
    }
  });

  it("is unsuitable when the workflow has no task or decision steps", async () => {
    const wf = workflow({
      nodes: [node("s", { type: "start" }), node("z", { type: "end" })],
      edges: [edge("e1", "s", "z")],
    });
    const result = await runRecommender(new FakeLlm({}), validatedResult(wf), neverAsk);
    expect(result.status).toBe("unsuitable");
  });

  it("is unsuitable when profiling exhausts the repair loop — no fabricated recommendations", async () => {
    const llm = new FakeLlm({ profiling: () => ({ profiles: [] }) });
    const result = await runRecommender(llm, validatedResult(tinyWorkflow()), neverAsk);
    expect(result.status).toBe("unsuitable");
    if (result.status === "unsuitable") {
      expect(result.reason).toContain("could not profile");
    }
  });

  it("recommends with zero rounds when profiling leaves no gaps", async () => {
    const llm = new FakeLlm({ profiling: profileHandler({ a: profile("a") }) });
    const result = await runRecommender(llm, validatedResult(tinyWorkflow()), neverAsk);
    expect(result.status).toBe("recommended");
    if (result.status === "recommended") {
      expect(result.rounds).toEqual([]);
      expect(result.opportunities.length).toBeGreaterThan(0);
      expect(result.provenance["profile.a.class"]).toBe("inferred");
    }
  });

  it("validates after a clarification round, with user_elicited provenance", async () => {
    const llm = new FakeLlm({
      profiling: profileHandler({ a: profile("a", { frequency: null }) }),
    });
    const io = scriptedIO({
      stopped: false,
      answers: [{ questionId: "missing_attribute:a:frequency", answer: "daily" }],
    });
    const result = await runRecommender(llm, validatedResult(tinyWorkflow()), io);
    expect(result.status).toBe("recommended");
    if (result.status === "recommended") {
      expect(result.rounds).toHaveLength(1);
      expect(result.rounds[0].applied).toHaveLength(1);
      expect(result.profiles[0].attributes.frequency.value).toBe("daily");
      expect(result.provenance["profile.a.attr.frequency"]).toBe("user_elicited");
    }
  });

  it("partial when the user stops — recommendations are STILL produced", async () => {
    const llm = new FakeLlm({
      profiling: profileHandler({ a: profile("a", { frequency: null }) }),
    });
    const result = await runRecommender(llm, validatedResult(tinyWorkflow()), scriptedIO());
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("ended clarification");
      expect(result.openQuestions.map((q) => q.id)).toContain("missing_attribute:a:frequency");
      // Gaps never block: conservative scoring, low confidence, but ranked output.
      expect(result.opportunities.length).toBeGreaterThan(0);
      expect(result.opportunities.every((o) => o.confidence === "low")).toBe(true);
    }
  });

  it("partial when answers resolve nothing (prevents infinite re-asking)", async () => {
    const llm = new FakeLlm({
      profiling: profileHandler({ a: profile("a", { frequency: null }) }),
    });
    const io = scriptedIO({
      stopped: false,
      answers: [{ questionId: "missing_attribute:a:frequency", answer: "no idea, sorry" }],
    });
    const result = await runRecommender(llm, validatedResult(tinyWorkflow()), io);
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("did not resolve");
    }
  });

  it("partial at the round cap", async () => {
    const llm = new FakeLlm({
      profiling: profileHandler({ a: profile("a", { frequency: null }) }),
    });
    const result = await runRecommender(llm, validatedResult(tinyWorkflow()), neverAsk, {
      maxRounds: 0,
    });
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("round limit");
    }
  });
});

describe("runRecommender — workflow-level sensitivity question", () => {
  function twoNodeWorkflow() {
    return workflow({
      nodes: [node("s", { type: "start" }), node("a"), node("b"), node("z", { type: "end" })],
      edges: [edge("e1", "s", "a"), edge("e2", "a", "b"), edge("e3", "b", "z")],
    });
  }

  it("asks ONE workflow-level question for N unknown sensitivities and fills them all", async () => {
    const llm = new FakeLlm({
      profiling: profileHandler({
        a: profile("a", { dataSensitivity: null }),
        b: profile("b", { dataSensitivity: null }),
      }),
    });
    const io = scriptedIO({
      stopped: false,
      answers: [{ questionId: "workflow_data_sensitivity", answer: "confidential" }],
    });
    const result = await runRecommender(llm, validatedResult(twoNodeWorkflow()), io);
    expect(result.status).toBe("recommended");
    expect(io.seen).toHaveLength(1);
    expect(io.seen[0].map((q) => q.id)).toEqual(["workflow_data_sensitivity"]);
    if (result.status === "recommended") {
      for (const p of result.profiles) {
        expect(p.attributes.dataSensitivity.value).toBe("confidential");
      }
    }
  });

  it("falls back to per-node sensitivity questions after the workflow question is skipped", async () => {
    const llm = new FakeLlm({
      profiling: profileHandler({
        a: profile("a", { dataSensitivity: null, frequency: null }),
        b: profile("b", { dataSensitivity: null }),
      }),
    });
    const io = scriptedIO(
      // Round 1: answer the frequency question, skip the workflow-level one.
      { stopped: false, answers: [{ questionId: "missing_attribute:a:frequency", answer: "daily" }] },
      // Round 2: the per-node fallback.
      {
        stopped: false,
        answers: [
          { questionId: "missing_attribute:a:dataSensitivity", answer: "internal" },
          { questionId: "missing_attribute:b:dataSensitivity", answer: "public" },
        ],
      },
    );
    const result = await runRecommender(llm, validatedResult(twoNodeWorkflow()), io);
    expect(result.status).toBe("recommended");
    expect(io.seen[0].map((q) => q.id)).toContain("workflow_data_sensitivity");
    expect(io.seen[1].map((q) => q.id)).toEqual([
      "missing_attribute:a:dataSensitivity",
      "missing_attribute:b:dataSensitivity",
    ]);
  });
});

describe("runRecommender — the RE knowledge pipeline (sample domain)", () => {
  async function runRePipeline() {
    const byId = Object.fromEntries(reKnowledgeProfiles().map((p) => [p.nodeId, p]));
    const llm = new FakeLlm({ profiling: profileHandler(byId) });
    return runRecommender(llm, validatedResult(reKnowledgePipeline()), neverAsk);
  }

  it("detects the verify→distill rework loop and recommends eval-harness automation on it", async () => {
    const result = await runRePipeline();
    expect(result.status).toBe("recommended");
    if (result.status !== "recommended") return;

    const loop = result.motifs.find((m) => m.kind === "rework_loop");
    expect(loop).toBeDefined();
    expect(result.opportunities.map((o) => o.id)).toContain("pat.eval_harness_automation@verify");
    expect(
      result.opportunities.some(
        (o) => o.patternId === "pat.eval_harness_automation" && o.target.kind === "motif",
      ),
    ).toBe(true);
  });

  it("recommends knowledge-work patterns for the research steps", async () => {
    const result = await runRePipeline();
    if (result.status !== "recommended") throw new Error(result.status);
    const ids = result.opportunities.map((o) => o.id);
    expect(ids).toContain("pat.automated_source_monitoring@collect");
    expect(ids).toContain("pat.rag_knowledge_base@distill");
  });

  it("never recommends adding AI to the step an AI agent already performs", async () => {
    const result = await runRePipeline();
    if (result.status !== "recommended") throw new Error(result.status);
    const adoption = [
      "pat.ai_extraction_assist",
      "pat.ai_extraction_automate",
      "pat.ai_drafting_assist",
      "pat.ai_classification_routing",
      "pat.ai_qa_check",
      "pat.ai_summarize_monitoring",
      "pat.ai_agent_orchestration",
    ];
    const onAgentStep = result.opportunities.filter(
      (o) =>
        o.target.kind === "node" &&
        o.target.nodeId === "agent_assist" &&
        adoption.includes(o.patternId),
    );
    expect(onAgentStep).toEqual([]);
  });

  it("every opportunity is explainable: factors, explanation, stable ids", async () => {
    const result = await runRePipeline();
    if (result.status !== "recommended") throw new Error(result.status);
    for (const opp of result.opportunities) {
      expect(opp.id).toBe(`${opp.patternId}@${opp.target.kind === "node" ? opp.target.nodeId : opp.target.motifId}`);
      expect(opp.explanation).toContain(`Total ${opp.score.total}/100`);
      expect(opp.variants.length).toBeGreaterThan(0);
      expect(opp.adviceRefs).toEqual([]);
    }
    // Ranked best-first.
    const totals = result.opportunities.map((o) => o.score.total);
    expect([...totals].sort((x, y) => y - x)).toEqual(totals);
  });
});

describe("runRecommender — partial preprocessor inputs", () => {
  it("skips null-typed nodes, echoes inherited questions, and links affectedBy", async () => {
    const wf = workflow({
      nodes: [
        node("s", { type: "start" }),
        node("a", { label: "Enter data" }),
        node("mystery", { type: null }),
        node("z", { type: "end" }),
      ],
      edges: [edge("e1", "s", "a"), edge("e2", "a", "mystery"), edge("e3", "mystery", "z")],
    });
    const inherited = [
      {
        id: "missing_node_type:mystery",
        text: "What kind of step is mystery?",
        gap: { kind: "missing_node_type", nodeId: "mystery" },
      },
      {
        id: "dead_end:a",
        text: "What happens after a?",
        gap: { kind: "dead_end", nodeId: "a" },
      },
    ];
    const llm = new FakeLlm({ profiling: profileHandler({ a: profile("a") }) });
    const result = await runRecommender(llm, partialResult(wf, inherited), neverAsk);
    expect(result.status).toBe("recommended"); // profiling itself had no gaps
    if (result.status !== "recommended") return;

    expect(result.source.preprocessStatus).toBe("partial");
    expect(result.skippedNodes).toEqual([{ nodeId: "mystery", why: "unknown_type" }]);
    expect(result.inheritedOpenQuestions.map((q) => q.id)).toEqual([
      "missing_node_type:mystery",
      "dead_end:a",
    ]);
    // The question about node a drags every opportunity on a down to low.
    for (const opp of result.opportunities) {
      if (opp.target.kind === "node" && opp.target.nodeId === "a") {
        expect(opp.affectedBy).toContain("dead_end:a");
        expect(opp.confidence).toBe("low");
      }
    }
  });
});
