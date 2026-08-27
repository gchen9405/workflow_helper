/**
 * End-to-end orchestration with a stubbed LlmClient — no network. Covers
 * every pipeline status, both clarification loops threaded through the one
 * IO seam, the default (silent) IO, the summary switch, progress events,
 * stage failures, image input, and the JSON round trip a web backend does.
 */
import { describe, expect, it } from "vitest";
import {
  LlmHttpError,
  PIXEL_PNG_BASE64,
  loadInputFromBuffer,
  textInput,
  type BatchAnswers,
} from "workflow-preprocessor";
import {
  isChoiceQuestion,
  PipelineStageError,
  runPipeline,
  type ClarificationStage,
  type PipelineClarificationIO,
  type PipelineProgress,
  type PipelineQuestion,
} from "../src/pipeline/run.js";
import { FakeLlm } from "./fakeLlm.js";
import {
  fillLabel,
  happyHandlers,
  profileOrderThin,
  rejectTriage,
  thinDraft,
} from "./fixtures.js";

interface AskedBatch {
  stage: ClarificationStage;
  round: number;
  questions: PipelineQuestion[];
}

/** An IO that records what it was asked and answers from a script. */
function scriptedIO(
  answer: (batch: AskedBatch) => BatchAnswers,
): PipelineClarificationIO & { asked: AskedBatch[] } {
  const asked: AskedBatch[] = [];
  return {
    asked,
    async askBatch(questions, round, stage) {
      const batch = { stage, round, questions: [...questions] };
      asked.push(batch);
      return answer(batch);
    },
  };
}

const neverAsk: PipelineClarificationIO = {
  askBatch: () => {
    throw new Error("clarification should not have been needed");
  },
};

describe("runPipeline — statuses", () => {
  it("complete: validated → recommended → model summary on the report", async () => {
    const llm = new FakeLlm(happyHandlers());
    const result = await runPipeline(llm, textInput("An order comes in, then …"), {
      io: neverAsk,
      inputLabel: "order.txt",
    });

    expect(result.status).toBe("complete");
    expect(result.preprocess.status).toBe("validated");
    expect(result.recommendation.status).toBe("recommended");
    expect(result.narration.status).toBe("complete");
    expect(result.narration.summary?.kind).toBe("model");
    // triage + normalization + extraction, profiling, summary — and nothing else.
    expect(llm.labels).toEqual(["triage", "normalization", "extraction", "profiling", "summary"]);

    expect(result.report).toBe(result.narration.report);
    expect(result.report.startsWith("# Improvement report — Order fulfillment")).toBe(true);
    // Step names reached the report from the in-memory schema, no file needed.
    expect(result.report).toContain("Validate order");
    expect(result.report).not.toContain("Step names were unavailable");
    expect(result.report).toContain("Generated from `order.txt`");
    expect(result.recommendation.status === "recommended" && result.recommendation.opportunities.length).toBeGreaterThan(0);
  });

  it("notice: rejected → unsuitable → a notice, after a single triage call and no questions", async () => {
    const llm = new FakeLlm({ ...happyHandlers(), triage: rejectTriage });
    const result = await runPipeline(llm, textInput("Q3 revenue was $4.2M"), { io: neverAsk });

    expect(result.status).toBe("notice");
    expect(result.preprocess.status).toBe("rejected");
    expect(result.recommendation.status).toBe("unsuitable");
    expect(result.narration.summary).toBeNull();
    expect(llm.labels).toEqual(["triage"]);
    expect(result.report).toContain("## Nothing to recommend on");
    expect(result.report).toContain("quarterly revenue summary");
  });

  it("fallback: the summary call fails, the deterministic report stands", async () => {
    const llm = new FakeLlm({
      ...happyHandlers(),
      summary: () => {
        throw new LlmHttpError(503, "the LLM endpoint returned HTTP 503");
      },
    });
    const result = await runPipeline(llm, textInput("An order comes in, then …"), { io: neverAsk });

    expect(result.status).toBe("fallback");
    expect(result.recommendation.status).toBe("recommended");
    if (result.narration.summary?.kind !== "deterministic") throw new Error("expected deterministic");
    expect(result.narration.summary.reason).toContain("HTTP 503");
    expect(result.report).toContain("## The recommendations");
  });

  it("summary: false skips the model summary and is still complete", async () => {
    const llm = new FakeLlm({
      ...happyHandlers(),
      summary: () => {
        throw new Error("must not be called");
      },
    });
    const result = await runPipeline(llm, textInput("An order comes in, then …"), {
      io: neverAsk,
      summary: false,
    });
    expect(result.status).toBe("complete");
    expect(result.narration.summary?.kind).toBe("deterministic");
    expect(llm.labels).not.toContain("summary");
  });
});

describe("runPipeline — clarification through the one seam", () => {
  it("threads both loops, naming the stage, and applies the answers", async () => {
    const llm = new FakeLlm({
      ...happyHandlers(),
      extraction: () => thinDraft(),
      "answer application": fillLabel,
      profiling: profileOrderThin,
    });
    const io = scriptedIO(({ stage, questions }) => ({
      stopped: false,
      answers: questions.map((q) => ({
        questionId: q.id,
        // Free text for the preprocessor; an option number for the recommender.
        answer: stage === "preprocess" ? "That step validates the order" : "2",
      })),
    }));

    const result = await runPipeline(llm, textInput("thin process"), { io });

    expect(io.asked.map((b) => [b.stage, b.round])).toEqual([
      ["preprocess", 1],
      ["recommend", 1],
    ]);
    expect(io.asked[0].questions.map((q) => q.id)).toEqual(["missing_node_label:a"]);
    expect(io.asked[0].questions.some(isChoiceQuestion)).toBe(false);
    expect(io.asked[1].questions.map((q) => q.id)).toEqual(["missing_attribute:x:duration"]);
    expect(io.asked[1].questions.every(isChoiceQuestion)).toBe(true);
    if (isChoiceQuestion(io.asked[1].questions[0])) {
      expect(io.asked[1].questions[0].options[1]).toBe("5_to_30_min");
    }

    expect(result.status).toBe("complete");
    expect(result.preprocess.status).toBe("validated");
    if (result.preprocess.status !== "validated") return;
    expect(result.preprocess.schema.provenance["node.a.label"]).toBe("user_elicited");
    expect(result.preprocess.rounds).toHaveLength(1);
    expect(result.recommendation.status).toBe("recommended");
    if (result.recommendation.status !== "recommended") return;
    expect(result.recommendation.rounds).toHaveLength(1);
    expect(result.recommendation.provenance["profile.x.attr.duration"]).toBe("user_elicited");
    expect(llm.labels).toEqual([
      "triage",
      "normalization",
      "extraction",
      "answer application",
      "profiling",
      "summary",
    ]);
  });

  it("asks nothing by default: thin input yields a partial analysis, still a complete report", async () => {
    const llm = new FakeLlm({
      ...happyHandlers(),
      extraction: () => thinDraft(),
      profiling: profileOrderThin,
    });
    const result = await runPipeline(llm, textInput("thin process"));

    expect(result.status).toBe("complete");
    expect(result.preprocess.status).toBe("partial");
    expect(result.recommendation.status).toBe("partial");
    if (result.preprocess.status !== "partial" || result.recommendation.status !== "partial") return;
    expect(result.preprocess.openQuestions.map((q) => q.id)).toEqual(["missing_node_label:a"]);
    expect(result.recommendation.openQuestions.map((q) => q.id)).toEqual(["missing_attribute:x:duration"]);
    expect(result.report).toContain("**This analysis is partial**");
    expect(result.report).toContain("## Open questions");
    expect(llm.labels).not.toContain("answer application");
  });

  it("honours the round cap per stage", async () => {
    const llm = new FakeLlm({
      ...happyHandlers(),
      extraction: () => thinDraft(),
      profiling: profileOrderThin,
    });
    const io = scriptedIO(() => ({ stopped: false, answers: [] })); // skip everything
    const result = await runPipeline(llm, textInput("thin"), { io, maxRounds: 0 });
    expect(io.asked).toEqual([]);
    expect(result.preprocess.status).toBe("partial");
    if (result.preprocess.status === "partial") expect(result.preprocess.reason).toContain("round limit (0)");
    expect(result.recommendation.status).toBe("partial");
  });

  it("wraps a rejecting clarification channel in a PipelineStageError", async () => {
    const llm = new FakeLlm({ ...happyHandlers(), extraction: () => thinDraft() });
    const io: PipelineClarificationIO = {
      askBatch: async () => {
        throw new Error("session closed");
      },
    };
    await expect(runPipeline(llm, textInput("thin"), { io })).rejects.toMatchObject({
      name: "PipelineStageError",
      stage: "preprocess",
      preprocess: null,
      cause: expect.objectContaining({ message: "session closed" }),
    });
  });
});

describe("runPipeline — progress and failures", () => {
  it("reports each stage's start and end with its status, in order", async () => {
    const events: PipelineProgress[] = [];
    await runPipeline(new FakeLlm(happyHandlers()), textInput("order"), {
      io: neverAsk,
      onProgress: (e) => events.push(e),
    });
    expect(events).toEqual([
      { stage: "preprocess", phase: "start" },
      { stage: "preprocess", phase: "end", status: "validated" },
      { stage: "recommend", phase: "start" },
      { stage: "recommend", phase: "end", status: "recommended" },
      { stage: "narrate", phase: "start" },
      { stage: "narrate", phase: "end", status: "complete" },
    ]);
  });

  it("a transport failure mid-run names the stage and keeps what was produced", async () => {
    const llm = new FakeLlm({
      ...happyHandlers(),
      profiling: () => {
        throw new LlmHttpError(502, "the LLM endpoint returned HTTP 502");
      },
    });
    let caught: unknown;
    try {
      await runPipeline(llm, textInput("order"), { io: neverAsk });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineStageError);
    if (!(caught instanceof PipelineStageError)) return;
    expect(caught.stage).toBe("recommend");
    expect(caught.message).toBe("the recommend stage failed: the LLM endpoint returned HTTP 502");
    expect(caught.cause).toBeInstanceOf(LlmHttpError);
    expect(caught.preprocess?.status).toBe("validated");
    expect(caught.recommendation).toBeNull();
  });

  it("a failure in the first stage carries no results", async () => {
    const llm = new FakeLlm({
      triage: () => {
        throw new Error("could not reach the LLM endpoint at http://x: ECONNREFUSED");
      },
    });
    await expect(runPipeline(llm, textInput("order"))).rejects.toMatchObject({
      stage: "preprocess",
      preprocess: null,
      recommendation: null,
    });
  });
});

describe("runPipeline — inputs and serialization", () => {
  it("passes an image through to the preprocessor's image-bearing calls", async () => {
    const seen: string[] = [];
    const handlers = happyHandlers();
    const llm = new FakeLlm({
      ...handlers,
      triage: (options) => {
        seen.push(...options.user.map((p) => p.type));
        return handlers.triage(options);
      },
    });
    const input = loadInputFromBuffer(Buffer.from(PIXEL_PNG_BASE64, "base64"), "flow.png");
    expect(input.kind).toBe("image");
    const result = await runPipeline(llm, input, { io: neverAsk });
    expect(seen).toContain("image");
    expect(result.status).toBe("complete");
  });

  it("the result is plain data: a JSON round trip preserves it", async () => {
    const result = await runPipeline(new FakeLlm(happyHandlers()), textInput("order"), { io: neverAsk });
    const wire = JSON.parse(JSON.stringify(result));
    expect(wire.status).toBe("complete");
    expect(wire.report).toBe(result.report);
    expect(wire.preprocess.schema.nodes).toHaveLength(6);
    expect(wire.recommendation.opportunities.length).toBeGreaterThan(0);
    expect(wire.narration.summary.kind).toBe("model");
  });
});
