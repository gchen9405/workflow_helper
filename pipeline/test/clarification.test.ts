import { describe, expect, it } from "vitest";
import type { BatchAnswers } from "workflow-preprocessor";
import { STAGE_BANNERS, stagedIO } from "../src/io/clarification.js";
import type { PipelineQuestion } from "../src/pipeline/run.js";

const q = (id: string): PipelineQuestion => ({
  id,
  text: `Q ${id}`,
  gap: { kind: "missing_workflow_name" },
});

describe("stagedIO", () => {
  it("announces each stage once and delegates every batch unchanged", async () => {
    const lines: string[] = [];
    const seen: { ids: string[]; round: number }[] = [];
    const inner = {
      async askBatch(questions: readonly { id: string }[], round: number): Promise<BatchAnswers> {
        seen.push({ ids: questions.map((x) => x.id), round });
        return { stopped: false, answers: [{ questionId: questions[0].id, answer: "ok" }] };
      },
    };
    const io = stagedIO(inner, (line) => lines.push(line));

    const first = await io.askBatch([q("a")], 1, "preprocess");
    await io.askBatch([q("b")], 2, "preprocess");
    await io.askBatch([q("c")], 1, "recommend");
    await io.askBatch([q("d")], 2, "recommend");

    expect(first).toEqual({ stopped: false, answers: [{ questionId: "a", answer: "ok" }] });
    expect(seen).toEqual([
      { ids: ["a"], round: 1 },
      { ids: ["b"], round: 2 },
      { ids: ["c"], round: 1 },
      { ids: ["d"], round: 2 },
    ]);
    expect(lines).toEqual([`\n${STAGE_BANNERS.preprocess}`, `\n${STAGE_BANNERS.recommend}`]);
  });

  it("re-announces if the subject changes back (never silently)", async () => {
    const lines: string[] = [];
    const io = stagedIO(
      { askBatch: async () => ({ stopped: true, answers: [] }) },
      (line) => lines.push(line),
    );
    await io.askBatch([q("a")], 1, "preprocess");
    await io.askBatch([q("b")], 1, "recommend");
    await io.askBatch([q("c")], 2, "preprocess");
    expect(lines).toHaveLength(3);
  });
});
