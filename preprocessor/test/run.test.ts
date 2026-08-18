/**
 * End-to-end orchestration tests with a stubbed LlmClient — no network.
 *
 * The stub honors the real client's contract: it validates canned fixtures
 * against the stage's actual Zod schema and runs the stage's semanticCheck,
 * so these tests also prove the fixtures (and the stage wiring) are shaped
 * exactly like real model output would have to be.
 *
 * Together the cases cover every terminal state the guarantee promises:
 * validated, partial (each trigger), and rejected (each trigger).
 */
import { describe, expect, it } from "vitest";
import {
  LlmRepairExhaustedError,
  type LlmClient,
  type StructuredCallOptions,
} from "../src/llm/client.js";
import { textInput } from "../src/io/input.js";
import {
  runPreprocessor,
  type BatchAnswers,
  type ClarificationIO,
} from "../src/pipeline/run.js";
import type { ExtractionDraft } from "../src/schema/workflow.js";

type Handler = (options: StructuredCallOptions<unknown>) => unknown;

class FakeLlm implements LlmClient {
  constructor(private readonly handlers: Record<string, Handler>) {}

  async structured<T>(options: StructuredCallOptions<T>): Promise<T> {
    const handler = this.handlers[options.taskLabel];
    if (!handler) throw new Error(`no fake handler for task "${options.taskLabel}"`);
    const value = options.schema.parse(handler(options as StructuredCallOptions<unknown>));
    const errors = options.semanticCheck?.(value) ?? [];
    if (errors.length > 0) {
      // Mirror the real client: semantic failure with no successful repair.
      throw new LlmRepairExhaustedError(options.taskLabel, 1, errors);
    }
    return value;
  }
}

const acceptTriage: Handler = () => ({ isWorkflow: true, reason: "describes a process" });
const normalize: Handler = () => ({ intermediate: "WORKFLOW: Flow\nNODES:\n..." });

/** Complete except for one missing node label. */
const thinDraft: ExtractionDraft = {
  name: "Flow",
  description: null,
  nodes: [
    { id: "s", type: "start", label: null, description: null, actor: null },
    { id: "e", type: "end", label: "Done", description: null, actor: null },
  ],
  edges: [{ id: "e1", from: "s", to: "e", label: null }],
};

const io = (
  ...batches: BatchAnswers[]
): ClarificationIO & { calls: number } => {
  const state = {
    calls: 0,
    async askBatch(): Promise<BatchAnswers> {
      const batch = batches[state.calls] ?? { stopped: true, answers: [] };
      state.calls++;
      return batch;
    },
  };
  return state;
};

const neverAsk: ClarificationIO = {
  askBatch: () => {
    throw new Error("clarification should not have been needed");
  },
};

describe("runPreprocessor — terminal states", () => {
  it("rejects non-workflow input with the triage reason", async () => {
    const llm = new FakeLlm({
      triage: () => ({ isWorkflow: false, reason: "it is a financial summary" }),
    });
    const result = await runPreprocessor(llm, textInput("revenue was $4.2M"), neverAsk);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("financial summary");
    }
  });

  it("rejects when extraction cannot produce a structurally valid graph", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => ({
        ...thinDraft,
        edges: [{ id: "e1", from: "s", to: "ghost", label: null }], // dangling
      }),
    });
    const result = await runPreprocessor(llm, textInput("some process"), neverAsk);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("structurally valid");
    }
  });

  it("validates a complete extraction with zero clarification rounds", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => ({
        ...thinDraft,
        nodes: thinDraft.nodes.map((n) =>
          n.id === "s" ? { ...n, label: "Kickoff" } : n,
        ),
      }),
    });
    const result = await runPreprocessor(llm, textInput("kickoff then done"), neverAsk);
    expect(result.status).toBe("validated");
    if (result.status === "validated") {
      expect(result.rounds).toEqual([]);
      expect(result.schema.provenance["node.s.label"]).toBe("original");
    }
  });

  it("validates after a clarification round fills the gap, with user_elicited provenance", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => thinDraft,
      "answer application": () => ({
        patches: [
          { op: "set_node_field", nodeId: "s", field: "label", value: "Kickoff meeting" },
        ],
      }),
    });
    const userIO = io({
      stopped: false,
      answers: [{ questionId: "missing_node_label:s", answer: "It's the kickoff meeting" }],
    });
    const result = await runPreprocessor(llm, textInput("thin process"), userIO);
    expect(result.status).toBe("validated");
    if (result.status === "validated") {
      expect(result.rounds).toHaveLength(1);
      expect(result.schema.nodes.find((n) => n.id === "s")?.label).toBe("Kickoff meeting");
      expect(result.schema.provenance["node.s.label"]).toBe("user_elicited");
      // Fields from the input keep their original provenance.
      expect(result.schema.provenance["node.e.label"]).toBe("original");
    }
  });

  it("returns partial with open questions when the user stops immediately", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => thinDraft,
    });
    const result = await runPreprocessor(llm, textInput("thin process"), io());
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("ended clarification");
      expect(result.openQuestions.map((q) => q.id)).toContain("missing_node_label:s");
      expect(result.schema.nodes).toHaveLength(2);
    }
  });

  it("returns partial when answers resolve nothing", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => thinDraft,
      "answer application": () => ({ patches: [] }),
    });
    const userIO = io({
      stopped: false,
      answers: [{ questionId: "missing_node_label:s", answer: "no idea, sorry" }],
    });
    const result = await runPreprocessor(llm, textInput("thin process"), userIO);
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("did not resolve");
    }
  });

  it("returns partial at the round cap", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => thinDraft,
    });
    const result = await runPreprocessor(llm, textInput("thin process"), neverAsk, {
      maxRounds: 0,
    });
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("round limit");
    }
  });

  it("applies answers given before a stop, then finishes", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => thinDraft,
      "answer application": () => ({
        patches: [
          { op: "set_node_field", nodeId: "s", field: "label", value: "Kickoff" },
        ],
      }),
    });
    // User answers the one question, then the batch reports stopped.
    const userIO = io({
      stopped: true,
      answers: [{ questionId: "missing_node_label:s", answer: "Kickoff" }],
    });
    const result = await runPreprocessor(llm, textInput("thin process"), userIO);
    // The answer closed the only gap, so stopping still yields validated.
    expect(result.status).toBe("validated");
  });
});
