/** Deterministic answer parsing and application (no LLM anywhere). */
import { describe, expect, it } from "vitest";
import { detectProfileGaps } from "../src/pipeline/gaps.js";
import { buildProfileQuestions } from "../src/pipeline/questions.js";
import { applyAnswers, parseChoice } from "../src/pipeline/answers.js";
import { stampProfileProvenance } from "../src/schema/profile.js";
import { node, profile, workflow } from "./helpers.js";

const wf = workflow({ nodes: [node("a"), node("b")] });

describe("parseChoice", () => {
  const options = ["ad_hoc", "monthly", "weekly", "daily", "many_per_day"] as const;

  it("accepts option numbers, with or without trailing punctuation", () => {
    expect(parseChoice("3", options)).toBe("weekly");
    expect(parseChoice("3)", options)).toBe("weekly");
    expect(parseChoice("3.", options)).toBe("weekly");
    expect(parseChoice("0", options)).toBeNull();
    expect(parseChoice("6", options)).toBeNull();
  });

  it("accepts tokens case-insensitively with spaces/hyphens for underscores", () => {
    expect(parseChoice("WEEKLY", options)).toBe("weekly");
    expect(parseChoice("ad hoc", options)).toBe("ad_hoc");
    expect(parseChoice("ad-hoc", options)).toBe("ad_hoc");
  });

  it("accepts unambiguous prefixes and rejects ambiguous or unknown text", () => {
    expect(parseChoice("week", options)).toBe("weekly");
    expect(parseChoice("m", ["monthly", "many_per_day"])).toBeNull(); // ambiguous
    expect(parseChoice("sometimes", options)).toBeNull();
    expect(parseChoice("", options)).toBeNull();
  });
});

describe("applyAnswers", () => {
  it("applies a parseable answer: value set, user_elicited provenance, basis cleared", () => {
    const profiles = [profile("a", { frequency: null })];
    const provenance = stampProfileProvenance(profiles);
    const questions = buildProfileQuestions(wf, detectProfileGaps(profiles));
    const outcome = applyAnswers(profiles, provenance, questions, [
      { questionId: "missing_attribute:a:frequency", answer: "daily" },
    ]);
    expect(outcome.applied).toEqual([
      { questionId: "missing_attribute:a:frequency", nodeIds: ["a"], field: "frequency", value: "daily" },
    ]);
    const applied = outcome.profiles[0].attributes.frequency;
    expect(applied).toEqual({ value: "daily", basis: null, evidence: null });
    expect(outcome.provenance["profile.a.attr.frequency"]).toBe("user_elicited");
    // Purity: the inputs were not mutated.
    expect(profiles[0].attributes.frequency.value).toBeNull();
    expect(provenance["profile.a.attr.frequency"]).toBeUndefined();
  });

  it("an unparseable answer applies nothing, so the gap persists", () => {
    const profiles = [profile("a", { frequency: null })];
    const questions = buildProfileQuestions(wf, detectProfileGaps(profiles));
    const outcome = applyAnswers(profiles, {}, questions, [
      { questionId: "missing_attribute:a:frequency", answer: "no idea" },
    ]);
    expect(outcome.applied).toEqual([]);
    expect(outcome.profiles[0].attributes.frequency.value).toBeNull();
  });

  it("taskClass answers apply the same way", () => {
    const profiles = [profile("a", { taskClass: null })];
    const questions = buildProfileQuestions(wf, detectProfileGaps(profiles));
    const outcome = applyAnswers(profiles, {}, questions, [
      { questionId: "missing_task_class:a", answer: "data entry" },
    ]);
    expect(outcome.profiles[0].taskClass.value).toBe("data_entry");
    expect(outcome.provenance["profile.a.class"]).toBe("user_elicited");
  });

  it("the workflow-level sensitivity answer fills every node still unknown, keeping known ones", () => {
    const profiles = [
      profile("a", { dataSensitivity: null }),
      profile("b", { dataSensitivity: "public" }),
    ];
    // Both unknown at question-build time in the real flow; here b is known,
    // proving the answer only touches nodes still null AT APPLY TIME.
    const questions = buildProfileQuestions(
      wf,
      detectProfileGaps([profile("a", { dataSensitivity: null }), profile("b", { dataSensitivity: null })]),
    );
    const outcome = applyAnswers(profiles, {}, questions, [
      { questionId: "workflow_data_sensitivity", answer: "confidential" },
    ]);
    expect(outcome.profiles[0].attributes.dataSensitivity.value).toBe("confidential");
    expect(outcome.profiles[1].attributes.dataSensitivity.value).toBe("public");
    expect(outcome.applied).toEqual([
      { questionId: "workflow_data_sensitivity", nodeIds: ["a"], field: "dataSensitivity", value: "confidential" },
    ]);
  });

  it("answers to unknown question ids are ignored", () => {
    const profiles = [profile("a")];
    const outcome = applyAnswers(profiles, {}, [], [{ questionId: "ghost", answer: "3" }]);
    expect(outcome.applied).toEqual([]);
  });
});
