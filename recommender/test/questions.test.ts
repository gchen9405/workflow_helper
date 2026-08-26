/** Question building: priority, caps, and the workflow-level sensitivity collapse. */
import { describe, expect, it } from "vitest";
import { detectProfileGaps } from "../src/pipeline/gaps.js";
import {
  buildProfileQuestions,
  WORKFLOW_SENSITIVITY_QUESTION_ID,
} from "../src/pipeline/questions.js";
import { node, profile, workflow } from "./helpers.js";

const wf = workflow({ nodes: [node("a", { label: "Reconcile invoices" }), node("b")] });

describe("buildProfileQuestions", () => {
  it("orders by priority: sensitivity, class, actor, frequency, duration, structure, judgment", () => {
    const gaps = detectProfileGaps([
      profile("a", {
        taskClass: null,
        frequency: null,
        duration: null,
        structure: null,
        judgment: null,
        dataSensitivity: null,
        actorKind: null,
      }),
    ]);
    const questions = buildProfileQuestions(wf, gaps, 10, { workflowSensitivityAsked: true });
    expect(questions.map((q) => q.id)).toEqual([
      "missing_attribute:a:dataSensitivity",
      "missing_task_class:a",
      "missing_attribute:a:actorKind",
      "missing_attribute:a:frequency",
      "missing_attribute:a:duration",
      "missing_attribute:a:structure",
      "missing_attribute:a:judgment",
    ]);
  });

  it("caps the batch", () => {
    const gaps = detectProfileGaps([
      profile("a", { frequency: null, duration: null, structure: null }),
      profile("b", { frequency: null, duration: null, structure: null }),
    ]);
    expect(buildProfileQuestions(wf, gaps, 4)).toHaveLength(4);
  });

  it("collapses ≥2 sensitivity gaps into one workflow-level question, asked first", () => {
    const gaps = detectProfileGaps([
      profile("a", { dataSensitivity: null, frequency: null }),
      profile("b", { dataSensitivity: null }),
    ]);
    const questions = buildProfileQuestions(wf, gaps);
    expect(questions[0].id).toBe(WORKFLOW_SENSITIVITY_QUESTION_ID);
    // The per-node sensitivity questions are absorbed by it this round.
    expect(questions.map((q) => q.id)).toEqual([
      WORKFLOW_SENSITIVITY_QUESTION_ID,
      "missing_attribute:a:frequency",
    ]);
    expect(questions[0].subject).toEqual({
      kind: "workflow_data_sensitivity",
      nodeIds: ["a", "b"],
    });
  });

  it("falls back to per-node sensitivity once the workflow question was asked", () => {
    const gaps = detectProfileGaps([
      profile("a", { dataSensitivity: null }),
      profile("b", { dataSensitivity: null }),
    ]);
    const questions = buildProfileQuestions(wf, gaps, 8, { workflowSensitivityAsked: true });
    expect(questions.map((q) => q.id)).toEqual([
      "missing_attribute:a:dataSensitivity",
      "missing_attribute:b:dataSensitivity",
    ]);
  });

  it("a single sensitivity gap stays per-node", () => {
    const gaps = detectProfileGaps([profile("a", { dataSensitivity: null })]);
    const questions = buildProfileQuestions(wf, gaps);
    expect(questions.map((q) => q.id)).toEqual(["missing_attribute:a:dataSensitivity"]);
  });

  it("question text names the step and shows numbered options matching `options`", () => {
    const gaps = detectProfileGaps([profile("a", { frequency: null })]);
    const [question] = buildProfileQuestions(wf, gaps);
    expect(question.text).toContain('"Reconcile invoices" (a)');
    expect(question.text).toContain("1) ad hoc");
    expect(question.options).toEqual(["ad_hoc", "monthly", "weekly", "daily", "many_per_day"]);
  });
});
