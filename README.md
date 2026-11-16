# workflow-helper

Helps you **work out a workflow for a problem you are facing**. The planned
pipeline has three steps:

1. **The brief** — you describe what is going wrong and any ideas you have
   (as text, or an image of notes or a sketch); an assistant talks it
   through with you until the problem, the goal, the nature of the work
   (what it acts on, whether its rules can be written down, how much cases
   vary, what mistakes cost), who you are (how technical, which tools you
   know) and the reasoning behind your ideas are understood.
2. **Resources** — an internal catalog of AI-native tools and resources is
   queried for the ones that help with *this* problem, fit your ideas, and
   suit your level — or the answer that AI does not help here and a
   deterministic approach (a script, rules, a checklist) is the better fit.
   *Not built yet.*
3. **The workflow** — the actual workflow is designed with you, sized to
   your level, from the brief and the chosen resources. *Not built yet;
   the conversation machinery for it exists as the "design" scope.*

This repo currently implements step 1: intake (triage, normalize, extract)
and the brief conversation. Its result is a **structured brief** — problem,
goal, constraints, your profile, your ideas with their reasoning, and any
concrete steps you described — with every piece marked by where it came
from.

```sh
npm install
cp .env.example .env          # fill in LLM_ENDPOINT and LLM_MODEL
npm run check                 # one trivial round trip to verify the config
npx tsx src/cli.ts examples/problem-only.txt
npx tsx src/cli.ts --text "We keep losing track of bug reports. …"
```

> See [What the next stage gets](#what-the-next-stage-gets) for how the
> result feeds step 2.

## The guarantee

Every input terminates in exactly **one of three states**:

| Status      | Meaning                                                                  |
|-------------|--------------------------------------------------------------------------|
| `validated` | Complete for the conversation's scope — deterministic gap detection found zero gaps. Today that means a complete brief. |
| `partial`   | A brief plus an explicit list of what is still open (you stopped, the turn cap was hit, or no conversation was possible). |
| `rejected`  | A graceful rejection with a stated reason (nothing a workflow could address, unreadable input, or a safety decline). |

Never a confident-looking brief from garbage input: a schema only exists
if triage accepted the input **and** extraction produced a structurally
valid one; anything less is `rejected` with the reason spelled out.

## How it works

```
                 ┌──────────┐   not a problem/process at all
input ──────────►│  triage  │──────────────────────────────► rejected (reason)
(text | image)   └────┬─────┘
                      │ something a workflow could address
                      ▼
                 ┌───────────┐    text intermediate: PROBLEM / GOAL / CONSTRAINTS /
                 │ normalize │───► the person's PROFILE / their IDEAS + any steps
                 └────┬──────┘     they described (the ONLY stage that sees an image)
                      ▼
                 ┌───────────┐    ExtractionDraft: the brief + the graph,
                 │  extract  │───► usually with NO steps (unknowns = null,
                 └────┬──────┘     never guessed) + provenance stamp
                      ▼
        ┌────────────────────────────────────────────────┐
        │  the brief conversation (scope "brief")         │
        │                                                 │
        │   detectGaps (pure code) ──► open gaps          │  gaps == [] and you're done ► validated
        │     problem, goal, who it's for, each idea's    │
        │     reasoning, the shape of any steps described │
        │            │                                    │
        │            ▼                                    │
        │   respond: the agent asks, probes, reflects back│  you stop / turn cap /
        │   (never proposes steps or tools)               │  model can't continue   ► partial (+ open gaps)
        │            │                                    │
        │            ▼                                    │
        │   you reply in your own words                   │
        │            │                                    │
        │            ▼                                    │
        │   interpret: reply ──► patches (stated by you   │
        │   → user_elicited; dry-run validated, applied   │
        │   by code) ──► loop                             │
        └─────────────────────────────────────────────────┘
```

### The conversation

It is a free-form back-and-forth: you write in your own words, the agent
answers your questions, follows up when an answer is unclear, and takes
corrections. In the **brief** scope — the only one the pipeline uses today —
the agent's job is to understand, never to solve. Driven by the gap list, it
works through:

- **The problem.** What happens today, how often, who is affected, what it
  costs, what you have tried. A vague problem is narrowed with follow-ups
  until the agent can restate it in one specific sentence — and it does, so
  you can correct it.
- **The goal.** What a good outcome looks like, concretely, and what matters
  most.
- **The work itself.** What it acts on and in what form (filled-in forms
  and tables, or free-form emails, documents, conversations); whether you
  could write down how to handle every case so someone — or a script —
  could follow it without judgment, and where the exceptions are; how much
  cases differ; what it costs when a step gets it wrong; how often it runs;
  whether results must be explainable. These are the facts step 2 weighs a
  deterministic approach against AI on, so they are gathered from you, in
  plain terms with examples from your situation, never assumed.
- **You.** Technical level, background, tools, preferences (below).
- **Your ideas.** Each approach-level idea you brought ("maybe an LLM could
  sort the reports") is probed, not judged: what you expect it to achieve,
  why you think it would help, what you are unsure about, what it would
  need. No ideas is fine — the agent does not supply any.
- **Your steps**, if you described any: each must be identifiable (what
  happens, what kind of step, who does it) and branches need conditions. The
  agent does not extend or complete the sequence.
- **Constraints.**

It never proposes steps, tools or techniques, and if asked it says that
comes in a later step. When nothing is open it restates the brief in a few
sentences and invites corrections.

The **design** scope — the conversation for step 3, where the agent proposes
steps you accept or adjust, sized to your level, with `agent_proposed`
provenance — is implemented and tested but not wired into the pipeline yet
(`--scope design` on the CLI, or `scope: "design"` in the API, runs it).

**It designs for you, specifically.** The agent establishes how technical
you are — and it asks in a way that fits what you have shown. With no hint,
it asks plainly whether you write code or scripts, configure software, or
mostly use everyday apps. If you vaguely suggest some background (a script
you wrote, a system you run, a tool mentioned in passing), it follows that
thread and asks how familiar you are with two or three specific tools that
would plausibly help with *this* problem. If you are clearly non-technical,
it doesn't quiz you on tooling; it asks what you use day to day and who could
help with technical parts. It also asks what you have tried, what you would
rather avoid, and how much time you have. Then it sizes the design to your
level: fewer steps and familiar, manual tools for `none`/`basic`; automation,
integrations and named tooling for `intermediate`/`advanced` — explained at
your level either way, never proposing a tool you said you'd avoid.

Everything it learns about you lands in the schema's `profile` (technical
level, background, tools and how well you know them, notes), with
provenance, so the next stage can choose resources that fit you and explain
their trade-offs accordingly.

Each of your messages costs two model calls, deliberately split:

- **interpret** — your message → patch operations, in two lists: what you
  *stated* yourself (facts about the problem, constraints, steps — and about
  you: level, background, tool familiarity, preferences), and which of the
  agent's *proposals* you accepted (with your changes, if any), plus whether
  you want to stop. Strict: it encodes only what was said or accepted, never
  guesses, and its output is dry-run against the schema and repaired through
  the internal machine-facing loop before it counts. Corrections are patches
  too.
- **respond** — the updated schema and the gaps that *remain* → the agent's
  next message. Free-form: the agent decides what to ask or propose, how to
  group it, how to phrase it.

The split keeps the conversation honest. The reply is always composed
against the real gap list, computed by code after your patches applied — so
the agent never claims the design is complete when the detector disagrees,
and a proposal is not "in" the schema until you accept it. Gap detection,
patch application, provenance and termination stay deterministic; what the
agent *says* is not.

Ending it: say so in plain words ("that's all", "good enough for now"), or
type `/done` in the terminal (ends immediately, no model call). Either way
you get the design as it stands: `validated` if no gaps remain, otherwise
`partial` with every open gap listed. A cap on your messages (`--max-turns`,
default 40) makes termination unconditional.

### Design constraints this implements

1. **One state object, stateless model calls.** `SessionState`
   (`src/conversation/session.ts`) holds the schema, the open gaps, the
   transcript and the turn count, as plain JSON. Every model call is a pure
   function over a slice of it. `openConversation` and `sendMessage` return a
   *new* state and never mutate their input, so a web backend can hold the
   state between requests, and a failed call leaves the previous state usable.

2. **All modalities normalize to a text intermediate.** Text and images both
   become the same intermediate (`INTERMEDIATE_FORMAT` in
   `src/extract/prompts.ts`): the brief, then whatever steps the person
   already described. Extraction runs only on that text.

3. **Extraction never guesses.** Anything the input does not state is
   `null`; steps the person did not describe do not exist. Filling in is
   the conversation's job — and there, the agent *proposes* and you decide.
   For the four deciding task facts (input shape, rule specifiability,
   variability, error cost) this is enforced in code, not just prompted:
   intake clears whatever the model read into the input for them, so they
   are always gaps at the start and only your answer in conversation fills
   them (the agent asks you to confirm when your description already points
   to one). A brief therefore never comes back `validated` without a
   conversation.

4. **Machine repair ≠ the conversation.** Structurally invalid model output
   (fails the Zod schema, references a node that doesn't exist, a patch that
   won't apply) goes back to the model and the call is retried internally, a
   bounded number of times (`src/llm/client.ts`). You never see this.

5. **Gap detection is deterministic, unit-tested code** (`src/graph/gaps.ts`),
   and it is scoped: in the brief scope, the problem, goal, the four deciding
   task facts, technical level, each idea's reasoning, and the identifiability of any steps described; in
   the design scope, additionally reachability, dead ends, exit-less cycles
   (Tarjan SCC), start/end and the name. It is the agent's authoritative
   to-do list and the completeness condition — the conversation is complete
   exactly when `detectGaps()` returns `[]` for its scope.

6. **Per-field provenance.** The final schema carries a flat `provenance`
   map: every filled field, constraint, profile entry, idea and entity is
   `"original"` (read off the input), `"user_elicited"` (you said it in conversation) or
   `"agent_proposed"` (the agent suggested it and you accepted). Stamped by
   code, never by the model — so you can always tell which parts of the
   design were yours.

## The schema

The brief, plus a directed graph with **flat node and edge lists** — cycles
and reconverging branches are ordinary edge rows, so any process topology is
representable.

```jsonc
{
  "name": "Bug triage",                 // string | null
  "description": null,                  // string | null
  "problem": "Bug reports arrive by email, chat and in person and get lost",
  "goal": "Every report has an owner within a day and nothing is forgotten",
  "constraints": ["Must stay inside the institution's network"],
  "task": {                                 // the nature of the work — what step 2 weighs deterministic vs AI on
    "inputs": "bug reports arriving by email, chat and in person",
    "inputShape": "unstructured",           // "structured" | "unstructured" | "mixed"   (gap while null)
    "rulesSpecifiable": "partly",           // "fully" | "mostly" | "partly" | "no"      (gap while null)
    "variability": "high",                  // "low" | "medium" | "high"                 (gap while null)
    "errorCost": "medium",                  // "low" | "medium" | "high"                 (gap while null)
    "frequency": "a few a week",            // optional, in the person's words
    "auditability": null                    // "required" | "helpful" | "not_needed"; optional
  },
  "profile": {
    "technicalLevel": "basic",              // "none" | "basic" | "intermediate" | "advanced" | null
    "background": "PI of a four-person research group, not a programmer",
    "tools": [                              // specific tools, as named by the person
      { "name": "GitLab issues", "familiarity": "basic" },      // "unfamiliar" | "basic" | "fluent"
      { "name": "Python", "familiarity": "unfamiliar" }
    ],
    "notes": ["Would rather not maintain scripts", "One developer could set things up"]
  },
  "ideas": [                                // approach-level ideas, as opposed to concrete steps
    {
      "id": "llm_triage",
      "summary": "maybe an LLM could sort incoming reports",
      "rationale": "reports are free text in three different places",   // null = a gap: the agent probes it
      "concerns": "not sure it would be allowed on our network"         // optional
    }
  ],
  "nodes": [                                // only steps the person described (often none)
    {
      "id": "report_arrives",           // stable snake_case id
      "type": "start",                  // "start" | "end" | "task" | "decision" | null
      "label": "Report arrives",        // string | null
      "description": null,              // optional enrichment — null is allowed in a validated schema
      "actor": "any user"               // optional enrichment — null is allowed in a validated schema
    }
  ],
  "edges": [
    { "id": "e1", "from": "report_arrives", "to": "log_it", "label": null }
  ],
  "provenance": {
    "workflow.problem": "original",
    "workflow.goal": "user_elicited",
    "constraint.0": "original",
    "task.inputShape": "user_elicited",
    "task.rulesSpecifiable": "user_elicited",
    "profile.technicalLevel": "user_elicited",
    "profile.tool.gitlab_issues": "user_elicited",
    "profile.note.0": "user_elicited",
    "node.report_arrives": "agent_proposed",
    "node.report_arrives.type": "agent_proposed",
    "edge.e1": "agent_proposed"
  }
}
```

Provenance paths: `workflow.<field>`, `constraint.<index>`, `task.<field>`,
`profile.<field>`, `profile.tool.<key>`, `profile.note.<index>`, `idea.<id>`,
`idea.<id>.<field>`, `node.<id>` (the node's existence), `node.<id>.<field>`,
`edge.<id>`, `edge.<id>.label` — built only by `provenancePath` in
`src/schema/workflow.ts`.

### What the next stage gets

The planned next stage queries an internal graph of resources for the ones
that help with this task, fit the person's existing ideas, and suit their
level — and explains trade-offs, benefits and implementation details
accordingly. Everything it needs is in the result:

| It needs | Where it is |
|---|---|
| what the workflow is for | `schema.problem`, `schema.goal`, `schema.constraints` |
| whether judgment is needed at all — to weigh a deterministic approach against AI | `schema.task` (input shape, rule specifiability, variability, error cost, frequency, auditability) |
| the person's ideas, with their reasoning and doubts, to judge fit | `schema.ideas` |
| the person's level, to size suggestions and pitch explanations | `schema.profile.technicalLevel` |
| their domain and role | `schema.profile.background` |
| tools they know, don't know, or were asked about | `schema.profile.tools` (with familiarity) |
| preferences, things to avoid, time, who else is involved, what they tried | `schema.profile.notes` |
| any concrete steps the person described | `schema.nodes` / `schema.edges` |
| what is still undecided | `openGaps` (on a `partial` result) |
| the reasoning, verbatim | `transcript` |

## Gap catalogue

Each gap has a stable id and a plain-language description
(`src/graph/describe.ts`). The agent receives them in this priority order and
decides how to work through them; a `partial` result lists the ones still
open. Which gaps count depends on the scope (B = brief, D = design).

| Gap                    | Scope | Fires when                                                        |
|------------------------|-------|-------------------------------------------------------------------|
| `missing_problem`      | B D   | the `problem` is null — nothing to design against yet             |
| `missing_goal`         | B D   | the `goal` is null — no definition of a good outcome              |
| `missing_task_fact`    | B D   | a deciding task fact (`inputShape`, `rulesSpecifiable`, `variability`, `errorCost`) is null |
| `missing_technical_level` | B D | `profile.technicalLevel` is null — nothing can be sized           |
| `unexplored_idea`      | B D   | an idea's `rationale` is null — why they think it would help      |
| `missing_node_type`    | B D   | a described step's `type` is null                                 |
| `missing_node_label`   | B D   | a described step's `label` is null                                |
| `unlabeled_branch`     | B D   | a node has ≥ 2 outgoing edges and at least one lacks a condition  |
| `no_start_node`        |   D   | no `start` node exists (suppressed while any node type is unknown)|
| `no_end_node`          |   D   | no `end` node exists (suppressed while any node type is unknown)  |
| `dead_end`             |   D   | a known non-`end` node has no outgoing edges                      |
| `exitless_cycle`       |   D   | a cycle (SCC) cannot reach any end node (checked once ends exist) |
| `unreachable_nodes`    |   D   | start nodes exist and some nodes are unreachable from all of them |
| `missing_workflow_name`|   D   | the workflow name is null                                         |

In the brief scope an empty graph is complete: nothing has to be designed.
`description`, `actor`, `constraints`, the task's `inputs`, `frequency` and
`auditability`, an idea's `concerns` and the profile's `background`, `tools`
and `notes` are optional enrichment, never gaps — the
agent gathers them because the prompt tells it to, not because completeness
demands it.

Structural defects (duplicate ids, dangling edges) are **not** gaps: they can
only come from malformed model output, so they belong to the machine repair
loop (`validateGraphIntegrity`), never to you.

## The result

```jsonc
{
  "status": "partial",                      // "validated" | "partial" | "rejected"
  "schema": { … },                          // as above
  "openGaps": [                             // partial only: what is still open, in priority order
    { "id": "no_end_node", "gap": { "kind": "no_end_node" },
      "description": "There are no steps yet. What should the final step or outcome be?" }
  ],
  "reason": "the person ended the conversation with gaps still open",
  "intermediate": "WORKFLOW: UNKNOWN\nPROBLEM: …",   // the normalized text the brief was extracted from
  "transcript": [                           // the whole conversation, oldest first
    { "role": "assistant", "text": "You're losing bug reports that come in through several channels, …" },
    { "role": "user", "text": "Success would be every report having an owner within a day",
      "patches": [{ "op": "set_workflow_field", "field": "goal", "value": "Every report has an owner within a day" }],
      "accepted": [] },
    { "role": "assistant", "text": "Got it. I'd suggest the workflow starts when a report arrives, …" }
  ]
}
```

A user message's `patches` are what was applied from what you stated;
`accepted` are the agent's proposals you took up (both empty when the message
carried no usable information; both absent when the model could not interpret
it at all — the agent then asks you to rephrase, without a composed reply).

## Usage

### Setup, once

```sh
npm install
cp .env.example .env     # then fill in LLM_ENDPOINT and LLM_MODEL
npm run check            # verifies the config with one trivial round trip
```

`npm run check` prints the resolved configuration and probes each configured
route, so a wrong base URL, a stale key, an unknown deployment name, a gateway
that rejects `response_format`, or a "vision" model that isn't actually
multimodal all surface here rather than halfway through a real run.

The nearest `.env` is loaded automatically, searching upward from the current
directory. Real environment variables always win over the file, and the CLI
says which ones did. `--env <file>` picks a specific file; `--no-env` skips it.

### Giving it an input

Three routes, all reaching the same intake. Modality is decided by
**content, not filename** — an extension-less screenshot or an image on a
pipe is still an image.

```sh
npx tsx src/cli.ts --text "We keep losing track of bug reports. Three devs, no external SaaS."
npx tsx src/cli.ts examples/problem-with-ideas.txt       # notes, .txt or .md
npx tsx src/cli.ts ~/Desktop/whiteboard.png --out design.json   # a photo of a sketch
cat notes.md | npx tsx src/cli.ts                        # a pipe, with or without an explicit "-"
```

`examples/` has three inputs: a problem with no ideas, a problem with a
rough process already in mind, and a data table that is rejected.

Exit codes: `0` validated · `2` partial · `3` rejected · `1` error.

### The conversation in the terminal

```text
— Reply in your own words. Type /done at any time to finish with what has been gathered. —

Assistant: You're losing track of bug reports that come in by email, chat and in
           person — three developers and a PI, and everything has to stay on the
           institution's network. What would "working" look like to you: is it
           that every report is logged, that each one gets an owner, or something
           else?

You: every report gets an owner within a day, and we can see what's outstanding

Assistant: Clear. Before I suggest anything: you mentioned developers — are you
           one of them, or more on the PI side? And is your group already using
           something like GitLab issues, Jira, or a shared spreadsheet to track
           work, and how comfortable are you with it?

You: I'm the PI, I don't code. We have GitLab, I've used the issues a bit.

Assistant: Got it — I'll note that whatever we end up with should be runnable
           from GitLab issues without scripting. You mentioned an idea: having an
           AI sort the incoming reports. What are you hoping that would take off
           your plate, and is there anything about it you're unsure of — say,
           whether it's allowed on your network?

You: yes, but the PI should be the one assigning, not a developer

Assistant: Done — logging is the first task, then the PI assigns an owner. What
           should happen once the owner is set: is the report resolved when the
           fix ships, or when the reporter confirms it?
```

`--no-interactive` skips the conversation entirely, so the input comes back
as extracted — always a `partial`, since at least the four deciding task
facts are open until you answer for them. `--max-turns <n>` caps your messages (default 40). `--scope
design` runs the step-3 conversation instead of the brief.

Piping an input does not cost you the conversation — stdin is the input, so
your replies are read from the console device instead (`/dev/tty`, or
`CONIN$` on Windows), attempted only when stdout is still a terminal. Where
there is no console at all (CI, cron), the CLI says so and continues
non-interactively.

### Configuration

Every `LLM_*` setting can live in a `.env` file (see `.env.example`) instead
of being exported. Resolution order is **CLI flag → environment variable →
`.env` → default**.

| Setting | How | Default |
|---|---|---|
| LLM endpoint | `LLM_ENDPOINT` or `--endpoint` — base URL of your OpenAI-compatible endpoint (`/chat/completions` is appended when absent) | required |
| API key | `LLM_API_KEY` — sent as `Authorization: Bearer <key>` | optional |
| Model | `LLM_MODEL` or `--model` | required |
| Vision model | `LLM_VISION_MODEL` or `--vision-model` — VLM for image-processing calls (enables the vision/text split) | main model |
| Vision endpoint | `LLM_VISION_ENDPOINT` or `--vision-endpoint` | main endpoint |
| Vision API key | `LLM_VISION_API_KEY` | main key |
| Max output tokens | `LLM_MAX_TOKENS` | 8192 |
| JSON mode | `LLM_JSON_MODE=off` disables `response_format: {type: "json_object"}` | on |
| Turn cap | `--max-turns` / `SessionOptions.maxTurns` | 40 |
| Scope | `--scope` / `SessionOptions.scope` | brief |
| Env file | `--env <file>` to pick one, `--no-env` to skip | nearest `.env` |

### The LLM provider

`src/llm/internalClient.ts` talks to an **OpenAI-compatible chat-completions
endpoint** — the de facto protocol of internal LLM gateways (vLLM, LiteLLM,
corporate proxies).

- **Structured output** is enforced client-side: each call's Zod schema is
  converted to JSON Schema and embedded in the system prompt, JSON mode is
  requested, and the reply is parsed and validated locally. Invalid output
  goes through the machine-facing repair loop.
- **Safety declines** (`finish_reason: "content_filter"` or a `refusal`
  field) map onto `rejected` before a schema exists, and end the
  conversation (keeping everything applied so far) once one does.
- **Image input requires a vision-capable deployment** — images are sent as
  OpenAI-style `image_url` data URIs. Text input works with any chat model.
- **Different protocol?** Implement the one-method `LlmClient` interface
  (`src/llm/client.ts`) and pass your client in — nothing else changes.

**Vision/text split.** Only triage and normalization ever see an image, and
only for image input. Setting any `LLM_VISION_*` variable routes those calls
to the vision model and everything else — extraction and every conversation
turn — to the main model (`src/llm/routingClient.ts`). An image input costs
exactly two VLM calls.

## Library use

Everything in one call, with your own conversation channel:

```ts
import { createLlmClient, runSession, textInput, type ConversationIO } from "workflow-helper";

const io: ConversationIO = {
  // Show the agent's message, return the person's reply — or null to finish.
  async reply(message, state) { show(message); return await readLine(); },
};
const result = await runSession(createLlmClient(), textInput("…"), { io });   // scope: "brief" by default
switch (result.status) {
  case "validated": /* result.schema, result.transcript */ break;
  case "partial":   /* result.schema + result.openGaps + result.reason */ break;
  case "rejected":  /* result.reason */ break;
}
```

Or step by step, for a request/response host such as a website — the state
is plain JSON, so keep it wherever you keep sessions:

```ts
import {
  createLlmClient, intake, openConversation, sendMessage,
  lastAssistantMessage, resultFromConversation, textInput,
} from "workflow-helper/core";   // browser-safe: no Node built-ins

const llm = createLlmClient();                        // or point it at a same-origin proxy
const accepted = await intake(llm, textInput("…"));   // once
if (accepted.status === "rejected") { /* done */ }

let state = await openConversation(llm, accepted.workflow);     // the opening message (scope "brief")
show(lastAssistantMessage(state));

state = await sendMessage(llm, state, personsReply);            // per request; returns a NEW state
if (state.status === "open") show(lastAssistantMessage(state));

const result = resultFromConversation(state, accepted.intermediate);  // closes it if still open
```

`Conversation` wraps the same functions for hosts that keep the session in
memory (`Conversation.open`, `.send`, `.lastMessage`, `.close`,
`Conversation.resume(llm, storedState)`).

`examples/server.ts` (`npm run serve`) is a dependency-free reference server
over exactly this sequence: `POST /conversations`, `POST
/conversations/:id/messages`, `POST /conversations/:id/finish`.

## Project layout

```text
├── src/
│   ├── schema/
│   │   ├── workflow.ts      # the brief + graph schema, provenance, structural integrity checks
│   │   └── patches.ts       # patch ops + deterministic apply w/ provenance stamping
│   ├── graph/
│   │   ├── gaps.ts          # deterministic gap detection (the completeness condition)
│   │   └── describe.ts      # gap -> stable id + plain-language description, priority order
│   ├── extract/
│   │   ├── stages.ts        # intake LLM stages: triage, normalize, extract
│   │   └── prompts.ts       # their system prompts + the intermediate format spec
│   ├── conversation/
│   │   ├── session.ts       # SessionState, openConversation / sendMessage / close, Conversation
│   │   ├── agent.ts         # the two calls per turn: interpretMessage, composeReply
│   │   └── prompts.ts       # their system prompts
│   ├── llm/
│   │   ├── client.ts            # provider-neutral LlmClient interface + repair-loop errors
│   │   ├── internalClient.ts    # OpenAI-compatible endpoint client + repair loop
│   │   ├── routingClient.ts     # vision/text routing + createLlmClient factory
│   │   ├── repair.ts            # the machine-facing repair message
│   │   └── probe.ts             # --check connectivity/config probe + diagnosis
│   ├── io/
│   │   ├── payload.ts       # input payloads, content sniffing (browser-safe)
│   │   ├── input.ts         # file/stdin loading, path cleanup
│   │   ├── terminal.ts      # the conversation over readline / the console device
│   │   └── env.ts           # .env discovery and parsing (env vars win)
│   ├── run.ts               # orchestrator: intake, runSession, result builders
│   ├── cli.ts               # the CLI
│   ├── core.ts              # browser-safe public API (workflow-helper/core)
│   └── index.ts             # full public API (adds the Node-only pieces)
├── test/                    # vitest, entirely offline (stubbed LlmClient / fetch)
├── examples/                # sample inputs + the reference server
└── .env.example
```

## Testing

`npm test` runs entirely offline. It covers the deterministic core
exhaustively — every gap detector in both scopes (the brief, the task facts,
the technical level, ideas, SCC cycle analysis, the suppression rules), patch
application including constraints, the task, profile and idea ops and the
provenance source, gap descriptions and ordering, graph integrity — the
conversation state machine against a stubbed `LlmClient` (the opening; a
turn's stated and accepted patches with their provenance; every way it ends;
the uninterpretable-message and uncomposable-reply paths; purity across a
transport failure; what the agent is shown; the wrapper), the orchestrator
(all three terminal states, each `partial` trigger, the request/response
entry points through a JSON round trip), the terminal IO, the
internal-endpoint client against a stubbed `fetch`, the vision/text routing,
and the input layer.

## Extending

- **New gap detectors**: add a variant to `Gap`, a detector in `detectGaps`,
  a priority + description in `describe.ts`, and unit tests. The agent picks
  it up automatically — it works through whatever the list contains.
- **New patch ops**: extend `PatchSchema` + `applyPatches` (+ tests) and
  describe the op in `INTERPRET_SYSTEM`.
- **Changing how the agent talks**: `RESPOND_BRIEF_SYSTEM` and
  `RESPOND_DESIGN_SYSTEM` in `src/conversation/prompts.ts` are the whole
  personality per scope; nothing deterministic depends on their wording.
- **Wiring in step 3**: open a conversation with `scope: "design"` on the
  schema that steps 1 and 2 produced; the design prompt, proposals and
  `agent_proposed` provenance are already there.
