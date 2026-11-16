/**
 * End-to-end orchestration tests with a stubbed LlmClient — no network.
 *
 * Together the cases cover every terminal state the guarantee promises:
 * validated (only ever through a conversation), partial (each trigger), and
 * rejected (each trigger) — plus the request/response entry points a web
 * host uses instead of `runSession`.
 */
import { describe, expect, it } from "vitest";
import { FakeLlm, sequence, type Handler } from "./fakeLlm.js";
import { textInput } from "../src/io/input.js";
import {
  runSession,
  intake,
  resultFromConversation,
  resultFromIntake,
  type ConversationIO,
} from "../src/run.js";
import { openConversation, sendMessage } from "../src/conversation/session.js";
import type { ExtractionDraft } from "../src/schema/workflow.js";

const acceptTriage: Handler = () => ({ isWorkflow: true, reason: "describes a problem" });
const normalize: Handler = () => ({ intermediate: "WORKFLOW: UNKNOWN\nPROBLEM: reports get lost\n..." });

/** A problem with one unexplored idea and no goal: two brief gaps, no steps. */
const problemOnly: ExtractionDraft = {
  name: null,
  description: null,
  problem: "Bug reports get lost",
  goal: null,
  constraints: ["No external SaaS"],
  task: { ...{ inputs: "tickets", inputShape: "structured", rulesSpecifiable: "mostly", variability: "medium", errorCost: "medium", frequency: null, auditability: null }, inputs: "bug reports", inputShape: "unstructured", rulesSpecifiable: null },
  profile: { technicalLevel: "basic", background: "PI of a small research group", tools: [], notes: [] },
  ideas: [{ id: "llm_triage", summary: "an LLM could sort the reports", rationale: null, concerns: null }],
  nodes: [],
  edges: [],
};

/**
 * The four deciding task facts, as the person's answers. Intake clears
 * whatever extraction returned for them, so only the conversation sets them.
 */
const decidingFacts = [
  { op: "set_task_field", field: "inputShape", value: "unstructured" },
  { op: "set_task_field", field: "rulesSpecifiable", value: "partly" },
  { op: "set_task_field", field: "variability", value: "medium" },
  { op: "set_task_field", field: "errorCost", value: "medium" },
];
const decidingFactGaps = [
  "missing_task_fact:inputShape",
  "missing_task_fact:rulesSpecifiable",
  "missing_task_fact:variability",
  "missing_task_fact:errorCost",
];

/** Patches that complete the brief. */
const completeBrief = [
  { op: "set_workflow_field", field: "goal", value: "Every report gets an owner within a day" },
  ...decidingFacts,
  { op: "set_idea_field", ideaId: "llm_triage", field: "rationale", value: "reports are free text" },
];

/** A brief complete but for the deciding task facts, which intake always leaves to the conversation. */
const briefDone: ExtractionDraft = {
  ...problemOnly,
  goal: "Every report gets an owner within a day",
  task: { ...problemOnly.task, rulesSpecifiable: "partly" },
  ideas: [{ ...problemOnly.ideas[0], rationale: "reports are free text" }],
};

/** A fully specified workflow (nothing left to ask in either scope). */
const completeDraft: ExtractionDraft = {
  ...briefDone,
  name: "Bug triage",
  nodes: [
    { id: "s", type: "start", label: "Report arrives", description: null, actor: null },
    { id: "e", type: "end", label: "Owner assigned", description: null, actor: null },
  ],
  edges: [{ id: "e1", from: "s", to: "e", label: null }],
};

/** Patches that take the empty graph to a complete one. */
const buildOut = [
  { op: "set_workflow_field", field: "name", value: "Bug triage" },
  { op: "add_node", node: { id: "s", type: "start", label: "Report arrives", description: null, actor: null } },
  { op: "add_node", node: { id: "e", type: "end", label: "Owner assigned", description: null, actor: null } },
  { op: "add_edge", edge: { id: "e1", from: "s", to: "e", label: null } },
];

/** A scripted person: answers from the list, then ends the conversation. */
function scripted(...replies: (string | null)[]): ConversationIO & { shown: string[] } {
  let i = 0;
  const io = {
    shown: [] as string[],
    async reply(message: string): Promise<string | null> {
      io.shown.push(message);
      return i < replies.length ? replies[i++] : null;
    },
  };
  return io;
}

describe("runSession — terminal states", () => {
  it("rejects input no workflow could address, with the triage reason", async () => {
    const llm = new FakeLlm({
      triage: () => ({ isWorkflow: false, reason: "it is a financial summary" }),
    });
    const result = await runSession(llm, textInput("revenue was $4.2M"), { io: scripted() });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toContain("financial summary");
  });

  it("rejects when extraction cannot produce a structurally valid graph", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => ({
        ...completeDraft,
        edges: [{ id: "e1", from: "s", to: "ghost", label: null }], // dangling
      }),
    });
    const result = await runSession(llm, textInput("some process"), { io: scripted() });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toContain("usable brief");
  });

  it("returns partial with the open gaps when there is no conversation channel", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => problemOnly,
    });
    const result = await runSession(llm, textInput("reports get lost"));
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toBe("no conversation was held");
      // Extraction returned three of the deciding facts; intake cleared them.
      expect(result.openGaps.map((g: { id: string }) => g.id)).toEqual([
        "missing_goal",
        ...decidingFactGaps,
        "unexplored_idea:llm_triage",
      ]);
      expect(result.schema.task).toMatchObject({
        inputs: "bug reports",
        inputShape: null,
        rulesSpecifiable: null,
        variability: null,
        errorCost: null,
      });
      expect(Object.keys(result.schema.provenance).filter((k) => k.startsWith("task."))).toEqual([
        "task.inputs",
      ]);
      expect(result.schema.provenance["workflow.problem"]).toBe("original");
      expect(result.schema.provenance["constraint.0"]).toBe("original");
      expect(result.schema.provenance["profile.technicalLevel"]).toBe("original");
      expect(result.transcript).toEqual([]);
    }
  });

  it("never validates without a conversation: the deciding task facts are the person's to confirm", async () => {
    const silent = new FakeLlm({ triage: acceptTriage, normalization: normalize, extraction: () => briefDone });
    const direct = await runSession(silent, textInput("…"));
    expect(direct.status).toBe("partial");
    if (direct.status === "partial") {
      expect(direct.openGaps.map((g: { id: string }) => g.id)).toEqual(decidingFactGaps);
    }

    const talking = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => briefDone,
      "reply composition": sequence(
        { message: "It sounds like the reports are free text — is that right?" },
        { message: "I have what I need." },
      ),
      "message interpretation": () => ({ stated: decidingFacts, accepted: [], finish: false }),
    });
    const io = scripted("yes, free text; it takes reading, they differ a fair bit, a miss means rework");
    const reviewed = await runSession(talking, textInput("…"), { io });
    expect(reviewed.status).toBe("validated");
    if (reviewed.status === "validated") {
      expect(reviewed.transcript).toHaveLength(3);
      for (const field of ["inputShape", "rulesSpecifiable", "variability", "errorCost"]) {
        expect(reviewed.schema.provenance[`task.${field}`]).toBe("user_elicited");
      }
    }
  });

  it("brief scope: validates once the goal is known and the idea explained", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => problemOnly,
      "reply composition": sequence({ message: "What would a good outcome look like, and why the LLM idea?" }, { message: "I have what I need." }),
      "message interpretation": () => ({ stated: completeBrief, accepted: [], finish: false }),
    });
    const io = scripted("an owner within a day; reports are free text so an LLM could read them");
    const result = await runSession(llm, textInput("reports get lost"), { io });
    expect(result.status).toBe("validated");
    if (result.status === "validated") {
      expect(result.schema.goal).toBe("Every report gets an owner within a day");
      expect(result.schema.task.rulesSpecifiable).toBe("partly");
      expect(result.schema.provenance["task.rulesSpecifiable"]).toBe("user_elicited");
      expect(result.schema.ideas[0].rationale).toBe("reports are free text");
      expect(result.schema.provenance["idea.llm_triage"]).toBe("original");
      expect(result.schema.provenance["idea.llm_triage.rationale"]).toBe("user_elicited");
      expect(result.schema.nodes).toEqual([]);
    }
  });

  it("design scope: validates once the conversation has built the workflow out, with provenance per source", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => briefDone,
      "reply composition": sequence(
        { message: "Where should it start?" },
        { message: "I'd suggest: a report arrives, then an owner is assigned. OK?" },
        { message: "That completes it." },
      ),
      "message interpretation": sequence(
        { stated: [{ op: "set_workflow_field", field: "name", value: "Bug triage" }, ...decidingFacts], accepted: [], finish: false },
        { stated: [], accepted: buildOut.slice(1), finish: false },
      ),
    });
    const io = scripted("Let's call it bug triage", "yes, do that");
    const result = await runSession(llm, textInput("reports get lost"), { io, scope: "design" });
    expect(result.status).toBe("validated");
    if (result.status === "validated") {
      expect(io.shown).toHaveLength(3);
      expect(result.transcript.map((m: { role: string }) => m.role)).toEqual([
        "assistant", "user", "assistant", "user", "assistant",
      ]);
      expect(result.schema.name).toBe("Bug triage");
      expect(result.schema.nodes.map((n: { id: string }) => n.id)).toEqual(["s", "e"]);
      expect(result.schema.provenance["workflow.problem"]).toBe("original");
      expect(result.schema.provenance["workflow.name"]).toBe("user_elicited");
      expect(result.schema.provenance["node.s"]).toBe("agent_proposed");
      expect(result.schema.provenance["edge.e1"]).toBe("agent_proposed");
    }
  });

  it("returns partial when the host ends the conversation with gaps open", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => problemOnly,
      "reply composition": () => ({ message: "Where should it start?" }),
    });
    const result = await runSession(llm, textInput("…"), { io: scripted() });
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("closed with gaps still open");
      expect(result.openGaps.map((g: { id: string }) => g.id)).toContain("missing_goal");
      expect(result.transcript).toHaveLength(1);
    }
  });

  it("returns partial when the person says they are done with gaps open", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => problemOnly,
      "reply composition": () => ({ message: "Where should it start?" }),
      "message interpretation": () => ({ stated: [], accepted: [], finish: true }),
    });
    const result = await runSession(llm, textInput("…"), { io: scripted("good enough for now") });
    expect(result.status).toBe("partial");
    if (result.status === "partial") expect(result.reason).toContain("person ended");
  });

  it("returns partial at the turn cap", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => problemOnly,
      "reply composition": () => ({ message: "Where should it start?" }),
      "message interpretation": () => ({ stated: [], accepted: [], finish: false }),
    });
    const io = scripted("hmm", "not sure", "dunno");
    const result = await runSession(llm, textInput("…"), { io, maxTurns: 2 });
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("turn limit (2)");
      expect(io.shown).toHaveLength(2);
    }
  });

  it("returns partial when the assistant cannot start the conversation", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => problemOnly,
      "reply composition": () => ({ message: "   " }), // fails the semantic check
    });
    const result = await runSession(llm, textInput("…"), { io: scripted() });
    expect(result.status).toBe("partial");
    if (result.status === "partial") expect(result.reason).toContain("could not continue");
  });

  it("asks again on an empty reply instead of spending a turn", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => problemOnly,
      "reply composition": sequence({ message: "Goal?" }, { message: "Done." }),
      "message interpretation": () => ({ stated: completeBrief, accepted: [], finish: false }),
    });
    const result = await runSession(llm, textInput("…"), { io: scripted("", "  ", "like so") });
    expect(result.status).toBe("validated");
    expect(llm.count("message interpretation")).toBe(1);
  });
});

describe("request/response entry points", () => {
  it("intake + session functions + resultFromConversation reach the same states", async () => {
    const llm = new FakeLlm({
      triage: acceptTriage,
      normalization: normalize,
      extraction: () => problemOnly,
      "reply composition": sequence({ message: "Goal?" }, { message: "Done." }),
      "message interpretation": () => ({ stated: completeBrief, accepted: [], finish: false }),
    });
    const accepted = await intake(llm, textInput("…"));
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;

    // Before any conversation: partial, with the reason the host gives.
    const early = resultFromIntake(accepted.workflow, accepted.intermediate, "not started");
    expect(early).toMatchObject({ status: "partial", reason: "not started" });

    // The state survives a JSON round trip between "requests".
    let state = await openConversation(llm, accepted.workflow);
    state = JSON.parse(JSON.stringify(state));
    state = await sendMessage(llm, state, "like so");

    const result = resultFromConversation(state, accepted.intermediate);
    expect(result.status).toBe("validated");
    if (result.status === "validated") {
      expect(result.transcript).toHaveLength(3);
      expect(result.schema.provenance["workflow.goal"]).toBe("user_elicited");
    }
  });

  it("resultFromConversation closes an open state and reports why it is partial", async () => {
    const accepted = await intake(
      new FakeLlm({ triage: acceptTriage, normalization: normalize, extraction: () => problemOnly }),
      textInput("…"),
    );
    if (accepted.status !== "accepted") throw new Error("expected acceptance");
    const llm = new FakeLlm({ "reply composition": () => ({ message: "Goal?" }) });
    const state = await openConversation(llm, accepted.workflow);
    const result = resultFromConversation(state, accepted.intermediate);
    expect(result).toMatchObject({ status: "partial", reason: expect.stringContaining("closed") });
  });
});
