/**
 * The conversation's state machine, against a stubbed LlmClient.
 *
 * Covers: the opening; a turn that applies patches (with provenance and gap
 * recomputation); every way a conversation ends (person, host, turn cap,
 * model failure); the two failure paths inside a turn (uninterpretable
 * message → nudge; uncomposable reply → closed, patches kept); purity (the
 * input state is never mutated, and a transport failure leaves it usable);
 * what the agent is shown; and the class wrapper.
 */
import { describe, expect, it } from "vitest";
import { FakeLlm, sequence } from "./fakeLlm.js";
import { completeWorkflow, node, workflow } from "./helpers.js";
import {
  Conversation,
  closeConversation,
  lastAssistantMessage,
  openConversation,
  sendMessage,
  UNINTERPRETABLE_NUDGE,
} from "../src/conversation/session.js";
import { renderContext } from "../src/conversation/agent.js";
import { LlmRefusalError } from "../src/llm/client.js";

/** One gap: the start node has no label. */
const thin = () =>
  workflow({
    name: "Flow",
    nodes: [node("s", { type: "start", label: null }), node("e", { type: "end", label: "Done" })],
    edges: [{ id: "e1", from: "s", to: "e", label: null }],
    provenance: { "node.s": "original", "node.e": "original", "node.e.label": "original" },
  });

const labelPatch = { op: "set_node_field", nodeId: "s", field: "label", value: "Kickoff" };
const reply = (message: string) => () => ({ message });

describe("openConversation", () => {
  it("opens with the agent's message, the gaps in priority order, and a copy of the schema", async () => {
    const llm = new FakeLlm({ "reply composition": reply("Hi — what happens first?") });
    const wf = thin();
    const state = await openConversation(llm, wf);

    expect(state.status).toBe("open");
    expect(state.scope).toBe("brief");
    expect(state.turns).toBe(0);
    expect(state.transcript).toEqual([{ role: "assistant", text: "Hi — what happens first?" }]);
    expect(state.openGaps.map((g) => g.id)).toEqual(["missing_node_label:s"]);
    expect(lastAssistantMessage(state)).toBe("Hi — what happens first?");

    // The opener saw the schema and the gap list, and was asked to open.
    const shown = llm.calls[0].text;
    expect(shown).toContain('"id": "s"');
    expect(shown).toContain("[missing_node_label:s]");
    expect(shown).toContain("(no messages yet)");
    expect(shown).toContain("opening message");
    expect(shown).toContain("Scope of this conversation: BRIEF");

    // A copy: mutating the caller's workflow does not reach the session.
    wf.nodes[0].label = "mutated";
    expect(state.workflow.nodes[0].label).toBeNull();
  });

  it("closes immediately with model_failure when no opening can be composed", async () => {
    const llm = new FakeLlm({
      "reply composition": () => {
        throw new LlmRefusalError("reply composition");
      },
    });
    const state = await openConversation(llm, thin());
    expect(state.status).toBe("closed");
    expect(state.end).toMatchObject({ by: "model_failure" });
    expect(state.transcript).toEqual([]);
    expect(state.workflow.nodes).toHaveLength(2);
  });

  it("propagates transport failures", async () => {
    const llm = new FakeLlm({
      "reply composition": () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(openConversation(llm, thin())).rejects.toThrow("ECONNREFUSED");
  });
});

describe("sendMessage — a turn", () => {
  it("applies the interpreted patches with provenance, recomputes gaps, and appends the reply", async () => {
    const llm = new FakeLlm({
      "reply composition": sequence({ message: "What is the first step?" }, { message: "Got it — all complete." }),
      "message interpretation": () => ({ stated: [labelPatch], accepted: [], finish: false }),
    });
    const opened = await openConversation(llm, thin());
    const snapshot = structuredClone(opened);

    const next = await sendMessage(llm, opened, "  It's the kickoff meeting  ");

    expect(next.status).toBe("open");
    expect(next.turns).toBe(1);
    expect(next.workflow.nodes.find((n) => n.id === "s")?.label).toBe("Kickoff");
    expect(next.workflow.provenance["node.s.label"]).toBe("user_elicited");
    expect(next.workflow.provenance["node.e.label"]).toBe("original");
    expect(next.openGaps).toEqual([]);
    expect(next.transcript).toEqual([
      { role: "assistant", text: "What is the first step?" },
      { role: "user", text: "It's the kickoff meeting", patches: [labelPatch], accepted: [] },
      { role: "assistant", text: "Got it — all complete." },
    ]);

    // Pure: the input state is untouched.
    expect(opened).toEqual(snapshot);

    // Interpretation saw the latest message set apart from the transcript;
    // the reply saw the message with what was applied from it, and the
    // fresh (empty) gap list.
    const interpret = llm.calls.find((c) => c.taskLabel === "message interpretation")!;
    expect(interpret.text).toContain("LATEST message from the person (interpret this one):\nIt's the kickoff meeting");
    expect(interpret.text).toContain("[missing_node_label:s]");
    const respond = llm.calls.filter((c) => c.taskLabel === "reply composition")[1];
    expect(respond.text).toContain("PERSON: It's the kickoff meeting");
    expect(respond.text).toContain('set node s label = "Kickoff"');
    expect(respond.text).toContain("(none — the brief is complete)");
  });

  it("stamps accepted proposals as agent_proposed, after what the person stated", async () => {
    const proposal = [
      { op: "add_node", node: { id: "review", type: "task", label: "Review", description: null, actor: null } },
      { op: "add_edge", edge: { id: "e2", from: "s", to: "review", label: null } },
    ];
    const llm = new FakeLlm({
      "reply composition": sequence({ message: "Shall we add a review step?" }, { message: "Added." }),
      "message interpretation": () => ({ stated: [labelPatch], accepted: proposal, finish: false }),
    });
    const next = await sendMessage(llm, await openConversation(llm, thin()), "yes, and the first step is the kickoff");
    expect(next.workflow.provenance["node.s.label"]).toBe("user_elicited");
    expect(next.workflow.provenance["node.review"]).toBe("agent_proposed");
    expect(next.workflow.provenance["node.review.label"]).toBe("agent_proposed");
    expect(next.workflow.provenance["edge.e2"]).toBe("agent_proposed");
    expect(next.transcript.at(-2)).toMatchObject({ role: "user", patches: [labelPatch], accepted: proposal });
    // The reply saw both kinds of application, told apart.
    const respond = llm.calls.filter((c) => c.taskLabel === "reply composition")[1];
    expect(respond.text).toContain("from what they said: set node s label");
    expect(respond.text).toContain('accepted proposals: added node review ("Review")');
  });

  it("rejects an accepted proposal that does not apply, like any other patch", async () => {
    const llm = new FakeLlm({
      "reply composition": reply("?"),
      "message interpretation": () => ({
        stated: [],
        accepted: [{ op: "add_edge", edge: { id: "e9", from: "s", to: "nowhere", label: null } }],
        finish: false,
      }),
    });
    const next = await sendMessage(llm, await openConversation(llm, thin()), "yes");
    expect(next.transcript.at(-1)).toEqual({ role: "assistant", text: UNINTERPRETABLE_NUDGE });
    expect(next.workflow.edges).toHaveLength(1);
  });

  it("ends by the person when interpretation flags finish, without composing a reply", async () => {
    const llm = new FakeLlm({
      "reply composition": reply("What is the first step?"),
      "message interpretation": () => ({ stated: [], accepted: [], finish: true }),
    });
    const next = await sendMessage(llm, await openConversation(llm, thin()), "that's all I know");
    expect(next.status).toBe("closed");
    expect(next.end).toEqual({ by: "user" });
    expect(next.transcript.at(-1)).toEqual({ role: "user", text: "that's all I know", patches: [], accepted: [] });
    expect(llm.count("reply composition")).toBe(1);
  });

  it("applies what a finishing message still carried", async () => {
    const llm = new FakeLlm({
      "reply composition": reply("What is the first step?"),
      "message interpretation": () => ({ stated: [labelPatch], accepted: [], finish: true }),
    });
    const next = await sendMessage(llm, await openConversation(llm, thin()), "Kickoff, and that's it");
    expect(next.status).toBe("closed");
    expect(next.openGaps).toEqual([]);
    expect(next.workflow.nodes[0].label).toBe("Kickoff");
  });

  it("nudges instead of replying when the message cannot be interpreted, applying nothing", async () => {
    const llm = new FakeLlm({
      "reply composition": reply("What is the first step?"),
      // A patch against a node that does not exist fails the dry run.
      "message interpretation": () => ({
        stated: [{ op: "set_node_field", nodeId: "ghost", field: "label", value: "x" }],
        accepted: [],
        finish: false,
      }),
    });
    const next = await sendMessage(llm, await openConversation(llm, thin()), "???");
    expect(next.status).toBe("open");
    expect(next.turns).toBe(1);
    expect(next.workflow.nodes).toHaveLength(2);
    expect(next.openGaps.map((g) => g.id)).toEqual(["missing_node_label:s"]);
    expect(next.transcript.slice(1)).toEqual([
      { role: "user", text: "???" }, // no `patches`: interpretation failed
      { role: "assistant", text: UNINTERPRETABLE_NUDGE },
    ]);
    expect(llm.count("reply composition")).toBe(1);
    // The nudge is recorded without an "applied" annotation.
    expect(renderContext(next)).toContain("PERSON: ???\nASSISTANT: " + UNINTERPRETABLE_NUDGE);
  });

  it("closes with model_failure when no reply can be composed, keeping the applied patches", async () => {
    const llm = new FakeLlm({
      "reply composition": (_options, call) => {
        if (call === 0) return { message: "What is the first step?" };
        throw new LlmRefusalError("reply composition");
      },
      "message interpretation": () => ({ stated: [labelPatch], accepted: [], finish: false }),
    });
    const next = await sendMessage(llm, await openConversation(llm, thin()), "Kickoff");
    expect(next.status).toBe("closed");
    expect(next.end).toMatchObject({ by: "model_failure" });
    expect(next.workflow.nodes[0].label).toBe("Kickoff");
    expect(next.openGaps).toEqual([]);
  });

  it("closes at the turn cap", async () => {
    const llm = new FakeLlm({
      "reply composition": reply("Tell me more."),
      "message interpretation": () => ({ stated: [], accepted: [], finish: false }),
    });
    let state = await openConversation(llm, thin());
    state = await sendMessage(llm, state, "one", { maxTurns: 2 });
    expect(state.status).toBe("open");
    state = await sendMessage(llm, state, "two", { maxTurns: 2 });
    expect(state.status).toBe("closed");
    expect(state.end).toEqual({ by: "turn_limit", maxTurns: 2 });
    expect(state.turns).toBe(2);
  });

  it("propagates a transport failure and leaves the previous state usable", async () => {
    let fail = true;
    const llm = new FakeLlm({
      "reply composition": reply("What is the first step?"),
      "message interpretation": () => {
        if (fail) throw new Error("HTTP 503");
        return { stated: [labelPatch], accepted: [], finish: false };
      },
    });
    const opened = await openConversation(llm, thin());
    await expect(sendMessage(llm, opened, "Kickoff")).rejects.toThrow("HTTP 503");
    expect(opened.status).toBe("open");
    expect(opened.turns).toBe(0);
    fail = false;
    const retried = await sendMessage(llm, opened, "Kickoff");
    expect(retried.openGaps).toEqual([]);
  });

  it("rejects host errors: a closed conversation, an empty message", async () => {
    const llm = new FakeLlm({ "reply composition": reply("?") });
    const opened = await openConversation(llm, thin());
    await expect(sendMessage(llm, opened, "   ")).rejects.toThrow("empty");
    const shut = closeConversation(opened);
    await expect(sendMessage(llm, shut, "hello")).rejects.toThrow("closed");
  });
});

describe("scope", () => {
  it("design scope asks for the whole workflow where brief scope is already satisfied", async () => {
    const llm = new FakeLlm({ "reply composition": reply("?") });
    const empty = workflow({ name: null, nodes: [], edges: [] });
    const brief = await openConversation(llm, empty);
    expect(brief.openGaps).toEqual([]);
    const design = await openConversation(llm, empty, "design");
    expect(design.scope).toBe("design");
    expect(design.openGaps.map((g) => g.id)).toEqual(["no_start_node", "no_end_node", "missing_workflow_name"]);
    expect(llm.calls.at(-1)!.text).toContain("Scope of this conversation: DESIGN");
  });
});

describe("closeConversation", () => {
  it("closes by the host and is a no-op afterwards", async () => {
    const llm = new FakeLlm({ "reply composition": reply("?") });
    const opened = await openConversation(llm, thin());
    const shut = closeConversation(opened);
    expect(shut.end).toEqual({ by: "host" });
    expect(opened.status).toBe("open");
    expect(closeConversation(shut)).toBe(shut);
  });
});

describe("Conversation (wrapper)", () => {
  it("drives open → send → close over the pure functions", async () => {
    const llm = new FakeLlm({
      "reply composition": sequence({ message: "First?" }, { message: "Complete." }),
      "message interpretation": () => ({ stated: [labelPatch], accepted: [], finish: false }),
    });
    const conversation = await Conversation.open(llm, thin());
    expect(conversation.isOpen).toBe(true);
    expect(conversation.lastMessage).toBe("First?");

    expect(await conversation.send("Kickoff")).toBe("Complete.");
    expect(conversation.state.openGaps).toEqual([]);

    conversation.close();
    expect(conversation.isOpen).toBe(false);
    expect(conversation.state.end).toEqual({ by: "host" });
  });

  it("returns null from send when the turn ended the conversation, and resumes from stored state", async () => {
    const llm = new FakeLlm({
      "reply composition": reply("First?"),
      "message interpretation": () => ({ stated: [], accepted: [], finish: true }),
    });
    const stored = JSON.parse(JSON.stringify(await openConversation(llm, thin())));
    const conversation = Conversation.resume(llm, stored);
    expect(await conversation.send("done")).toBeNull();
    expect(conversation.state.end).toEqual({ by: "user" });
  });
});

describe("renderContext", () => {
  it("tells the agent what was recorded about the person", () => {
    const wf = completeWorkflow();
    const text = renderContext({
      scope: "brief",
      workflow: wf,
      openGaps: [],
      transcript: [
        { role: "assistant", text: "Do you write code?" },
        {
          role: "user",
          text: "A bit of Python; I'd rather not maintain scripts",
          patches: [
            { op: "set_technical_level", value: "basic" },
            { op: "set_tool_familiarity", name: "Python", familiarity: "basic" },
            { op: "add_profile_note", value: "Would rather not maintain scripts" },
          ],
          accepted: [],
        },
      ],
    });
    expect(text).toContain("set technical level = basic");
    expect(text).toContain('noted tool "Python": basic');
    expect(text).toContain('noted about the person: "Would rather not maintain scripts"');
    expect(text).toContain('"profile"');
  });

  it("shows the bare schema (no provenance), the gaps, and the transcript", () => {
    const wf = completeWorkflow();
    const text = renderContext({ scope: "brief", workflow: wf, openGaps: [], transcript: [] });
    expect(text).toContain('"name": "Order fulfillment"');
    expect(text).not.toContain("provenance");
    expect(text).toContain("(none — the brief is complete)");
    expect(text).toContain("(no messages yet)");
  });
});
