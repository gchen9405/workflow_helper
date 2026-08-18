# Workflow Preprocessor

Turns a workflow — given as a **flowchart image** or **free text** — into a
**validated, structured graph schema**. When the input is thin, it asks the
user targeted clarifying questions in batches until the schema is complete or
the user stops.

This folder is self-contained. Downstream components (e.g. matching the schema
against a database of other workflows) will live in sibling folders; nothing
here assumes it owns the repository root.

## The guarantee

Every input terminates in exactly **one of three states**:

| Status      | Meaning                                                                  |
|-------------|--------------------------------------------------------------------------|
| `validated` | A complete schema — deterministic gap detection found zero gaps.         |
| `partial`   | A schema plus an explicit list of open questions (user stopped, skipped, or the round cap was hit). |
| `rejected`  | A graceful rejection with a stated reason (non-workflow input, unreadable input, or a safety decline). |

Never a confident-looking schema from garbage input: a schema only exists if
triage accepted the input **and** extraction produced a structurally valid
graph; anything less is `rejected` with the reason spelled out.

## Pipeline

```
                 ┌──────────┐   not a workflow / unreadable
input ──────────►│  triage  │──────────────────────────────► rejected (reason)
(image | text)   └────┬─────┘
                      │ workflow
                      ▼
                 ┌───────────┐    graph-shaped text intermediate
                 │ normalize │───► (edge-list style; the ONLY stage
                 └────┬──────┘     that ever sees an image)
                      ▼
                 ┌───────────┐    ExtractionDraft (unknowns = null,
                 │  extract  │───► never guessed) + provenance stamp
                 └────┬──────┘
                      ▼
        ┌──────────────────────────────┐
        │  clarification loop          │
        │  ┌────────────────────────┐  │  gaps == []       ► validated
        │  │ detectGaps (pure code) │──┼─────────────────►
        │  └───────────┬────────────┘  │  user stops /
        │              ▼               │  round cap        ► partial (+ open questions)
        │   buildQuestions (batched)   │─────────────────►
        │              ▼               │
        │   ask user → answers         │
        │              ▼               │
        │   applyAnswers (LLM → patches│
        │   → deterministic apply +    │
        │     provenance stamping)     │
        └──────────────┴───loop────────┘
```

### Design constraints this implements

1. **One state object, stateless LLM calls.** `PreprocessorState`
   (`src/pipeline/run.ts`) holds everything: input, triage verdict,
   intermediate text, the workflow schema, current gaps, and the Q&A history.
   Every LLM call is a pure function over a slice of that object — no hidden
   conversation state between stages.

2. **All modalities normalize to a text intermediate.** Images and text both
   become the same edge-list-style intermediate (format spec:
   `INTERMEDIATE_FORMAT` in `src/llm/prompts.ts`). Extraction runs only on
   that text — never directly on an image. Triage runs first and rejects
   non-workflows gracefully.

3. **Extraction never guesses.** Any field the input does not show or state is
   `null`. Filling nulls is the user's job, via the clarification loop.

4. **Machine repair ≠ user clarification.** Two loops that never mix:
   - *Machine-facing repair* (`src/llm/client.ts`): when an LLM call's output
     is structurally invalid — fails the Zod schema, or semantic checks like
     "edge references a node that doesn't exist" — the errors go back to the
     model and the call is retried internally, a bounded number of times. The
     user never sees this.
   - *User-facing clarification* (`src/pipeline/run.ts` + `clarify.ts`): when
     the *input* lacks information, deterministic gap detection produces
     batched questions for the user, until the schema is complete or the user
     stops.

5. **Gap detection is deterministic, unit-tested code** (`src/pipeline/gaps.ts`):
   reachability, dead ends, unlabeled branches, exit-less cycles (Tarjan SCC),
   missing fields. It is the clarification loop's termination condition — the
   schema is complete exactly when `detectGaps()` returns `[]`.

6. **Per-field provenance.** The final schema carries a flat
   `provenance` map: every filled field and every entity is marked
   `"original"` (read off the input) or `"user_elicited"` (came from a
   clarification answer). Stamping is done by deterministic code, never by
   the model.

## The schema

A directed graph with **flat node and edge lists** — cycles and reconverging
branches are ordinary edge rows (`{ from, to }`), so any process topology is
representable.

```jsonc
{
  "name": "Order fulfillment",          // string | null
  "description": null,                  // string | null
  "nodes": [
    {
      "id": "check_stock",              // stable snake_case id
      "type": "decision",               // "start" | "end" | "task" | "decision" | null
      "label": "In stock?",             // string | null
      "description": null,              // optional enrichment — null is allowed in a validated schema
      "actor": "warehouse system"       // optional enrichment — null is allowed in a validated schema
    }
  ],
  "edges": [
    { "id": "e1", "from": "check_stock", "to": "pick_pack", "label": "yes" }
  ],
  "provenance": {
    "workflow.name": "original",
    "node.check_stock": "original",
    "node.check_stock.type": "original",
    "node.check_stock.actor": "user_elicited",
    "edge.e1": "original",
    "edge.e1.label": "user_elicited"
  }
}
```

Provenance paths: `workflow.<field>`, `node.<id>` (the node's existence),
`node.<id>.<field>`, `edge.<id>`, `edge.<id>.label` — built only by
`provenancePath` in `src/schema/workflow.ts`.

## Gap catalogue

Each gap maps 1:1 to a clarifying question (templates in
`src/pipeline/questions.ts`; question id = gap id, stable across rounds).

| Gap                    | Fires when                                                             |
|------------------------|------------------------------------------------------------------------|
| `missing_node_type`    | a node's `type` is null                                                |
| `missing_node_label`   | a node's `label` is null                                               |
| `no_start_node`        | no `start` node exists (suppressed while any node type is unknown)     |
| `no_end_node`          | no `end` node exists (suppressed while any node type is unknown)       |
| `unreachable_nodes`    | start nodes exist and some nodes are unreachable from all of them      |
| `dead_end`             | a known non-`end` node has no outgoing edges                           |
| `unlabeled_branch`     | a node has ≥ 2 outgoing edges and at least one lacks a condition label |
| `exitless_cycle`       | a cycle (SCC) cannot reach any end node (checked once ends exist)      |
| `missing_workflow_name`| the workflow name is null (always asked last)                          |

The suppression rules exist so one round never asks two versions of the same
question (e.g. "what type is this node?" and "where does the flow start?").
`description` and `actor` are optional enrichment — null there is *not* a gap.

Structural defects (duplicate ids, dangling edges) are **not** gaps: they can
only come from malformed model output, so they belong to the machine repair
loop (`validateGraphIntegrity`), never to the user.

## Question batching & termination

- Questions are ordered by fixed priority (types → start/end → labels →
  branch conditions → dead ends → cycles → reachability → name) and capped
  per round (default 8).
- The loop terminates when: gaps are empty (`validated`); the user types
  `stop` or skips everything (`partial`); a round's answers resolve nothing
  (`partial`); or the round cap (default 10) is hit (`partial`). The cap makes
  termination unconditional.

## Usage

### Setup, once

```sh
cd preprocessor
npm install
cp .env.example .env     # then fill in LLM_ENDPOINT and LLM_MODEL
npm run check            # verifies the config with one trivial round trip
```

`npm run check` prints the resolved configuration and probes each configured
route, so a wrong base URL, a stale key, an unknown deployment name, a gateway
that rejects `response_format`, or a "vision" model that isn't actually
multimodal all surface here rather than halfway through a real run:

```text
Configuration
  endpoint:  https://llm.internal.example/v1
  model:     your-deployment-name
  api key:   set (…a1b2)
  vision:    your-vlm-deployment @ https://llm.internal.example/v1

Probing…
  ✔ text model — reachable, authenticated, returning valid JSON
  ✔ vision model — reachable, authenticated, returning valid JSON

✔ Ready to run.
```

The nearest `.env` is loaded automatically, searching upward from the current
directory. Real environment variables always win over the file, and the CLI
says which ones did. `--env <file>` picks a specific file; `--no-env` skips it.

### The drop folder (no typing)

For anyone who should not have to touch a terminal command: drag files into
`inbox/`, then double-click the launcher for your platform. It opens a
terminal/console window, so the clarifying questions still happen right there.

```text
preprocessor/
├── Process workflows.command   ← double-click this on macOS
├── Process workflows.bat       ← double-click this on Windows
├── inbox/                      ← drag images or .txt/.md descriptions here
│   ├── README.txt              (instructions, skipped as an input)
│   └── processed/              (consumed inputs are moved here)
└── results/                    ← one <name>.json per input
```

On Linux, `npm run inbox` does the same thing.

Both launchers are written to survive a double-click rather than a shell. The
macOS one `cd`s to itself (Finder starts it in the home directory) and puts
Homebrew, MacPorts and nvm on `PATH`, because a Finder-launched script does not
read `~/.zshrc`. The Windows one `cd`s to `%~dp0` (a shortcut or "Run as
administrator" would not start there) and uses delayed expansion, since a
variable set inside a batch `if(...)` block cannot be read with `%var%` in the
same block. Both install dependencies on first run and, when there is no
`.env`, create one from `.env.example` and offer to open it.

Nothing is overwritten. Dropping `flow.png` twice keeps `processed/flow.png`
and `processed/flow-2.png`, with results in `flow.json` and `flow-2.json`.

The same thing from a terminal, with `--keep` to leave inputs in place:

```sh
npm run inbox
npx tsx src/cli.ts --inbox --keep
```

### Giving it an input

Four routes, all reaching the same pipeline. Modality is decided by **content,
not filename** — an extension-less screenshot or an image on a pipe is still
an image.

```sh
# A file
npx tsx src/cli.ts examples/order-fulfillment.txt
npx tsx src/cli.ts ~/Desktop/flowchart.png --out schema.json

# A path dragged in from Finder — quotes, escaped spaces and file:// URLs are
# all cleaned up, so this works as pasted
npx tsx src/cli.ts '/Users/me/Desktop/order flow (v2).png'

# Inline text
npx tsx src/cli.ts --text "New hire signs contract, then HR orders a laptop"

# The clipboard — an image if one is on it, otherwise the text
npx tsx src/cli.ts --clipboard

# A pipe, with or without an explicit "-"
cat notes.md | npx tsx src/cli.ts
pbpaste | npx tsx src/cli.ts -
npx tsx src/cli.ts - < flowchart.png

# A whole folder: every image and text file in it, one JSON per input
npx tsx src/cli.ts examples/ --out-dir results/
```

Folder mode prints a summary and exits with the worst status it saw:

```text
Summary
  ✔ order-fulfillment.txt  validated
  ◐ thin.txt               partial
  ✘ not-a-workflow.txt     rejected
  1 validated · 1 partial · 1 rejected
```

### Clarification

Questions are asked round by round: type an answer, press **Enter** to skip a
question, or type **`stop`** to finish with what has been gathered.
`--no-interactive` skips the loop entirely, so thin input comes back `partial`
with its open questions listed.

Piping an input does not cost you the clarification loop — stdin is the input,
so the questions are read from the console device instead (`/dev/tty`, or
`CONIN$` on Windows), attempted only when stdout is still a terminal. Where
there is no console at all (CI, cron), the CLI says so and continues
non-interactively.

Exit codes: `0` validated · `2` partial · `3` rejected · `1` error.

### Platform support

| | macOS | Windows | Linux |
|---|---|---|---|
| File, folder, `--text`, stdin | ✔ | ✔ | ✔ |
| Double-click launcher | `.command` | `.bat` | `npm run inbox` |
| `--clipboard` | osascript / pbpaste | PowerShell (WinForms) | wl-paste, then xclip |
| Questions when stdin is piped | `/dev/tty` | `CONIN$` | `/dev/tty` |

Path cleanup is platform-aware: backslash unescaping runs only on POSIX, since
on Windows the backslash is the path separator and `C:\$Recycle.Bin` would
otherwise be corrupted. Windows shells quote dragged paths instead, which the
quote stripping handles.

`--clipboard` on Linux needs `wl-clipboard` (Wayland) or `xclip` (X11)
installed; the error names both if neither is found.

### Configuration

Every `LLM_*` setting below can live in a `.env` file (see `.env.example`)
instead of being exported. Resolution order is **CLI flag → environment
variable → `.env` → default**, so an `export` in the current shell always beats
a stored default, and the CLI reports when that happens.

| Setting | How | Default |
|---|---|---|
| LLM endpoint | `LLM_ENDPOINT` env var or `--endpoint` — base URL of your internal OpenAI-compatible endpoint (`/chat/completions` is appended when absent) | required |
| API key | `LLM_API_KEY` env var — sent as `Authorization: Bearer <key>` | optional |
| Model | `LLM_MODEL` env var or `--model` — the model/deployment name your gateway expects | required |
| Vision model | `LLM_VISION_MODEL` env var or `--vision-model` — VLM for image-processing calls (enables the vision/text split) | main model |
| Vision endpoint | `LLM_VISION_ENDPOINT` env var or `--vision-endpoint` | main endpoint |
| Vision API key | `LLM_VISION_API_KEY` env var | main key |
| Max output tokens | `LLM_MAX_TOKENS` | 8192 |
| JSON mode | `LLM_JSON_MODE=off` disables `response_format: {type: "json_object"}` for gateways that reject the parameter | on |
| Round cap | `--max-rounds` | 10 |
| Questions per round | `RunOptions.maxQuestionsPerRound` (library) | 8 |
| Env file | `--env <file>` to pick one, `--no-env` to skip | nearest `.env`, searching upward |

### The LLM provider

`src/llm/internalClient.ts` talks to an **OpenAI-compatible chat-completions
endpoint** — the de facto protocol of internal LLM gateways (vLLM, LiteLLM,
corporate proxies). Points worth knowing:

- **Structured output** is enforced client-side: each stage's Zod schema is
  converted to JSON Schema and embedded in the system prompt, JSON mode is
  requested, and the reply is parsed and validated locally. Invalid output
  goes through the machine-facing repair loop, so a model that occasionally
  emits sloppy JSON still converges or fails loudly — never silently.
- **Safety declines** (`finish_reason: "content_filter"` or a `refusal`
  field) map directly onto the `rejected` terminal state with a stated
  reason — never retried into a schema.
- **Flowchart-image input requires a vision-capable deployment** — images are
  sent as OpenAI-style `image_url` data URIs. Text input works with any
  chat model.
- **Different protocol?** The pipeline only depends on the one-method
  `LlmClient` interface (`src/llm/client.ts`). Implement `structured()` for
  your protocol and pass your client to `runPreprocessor` — nothing else
  changes. A different auth header (e.g. Azure-style `api-key`) is a one-line
  change in `internalClient.ts`.

### Vision/text model split

Only calls whose content includes an image need a vision-capable model — in
this pipeline that is exactly **triage** and **normalization**, and only when
the input is a flowchart image (extraction and every clarification round run
on text by construction). Setting any `LLM_VISION_*` variable (or
`--vision-model` / `--vision-endpoint`) activates routing
(`src/llm/routingClient.ts`): image-bearing calls go to the vision model,
everything else to the main model. Unset vision values fall back to the
corresponding main setting, so "same gateway, different model" is just
`LLM_VISION_MODEL`, while a fully separate VLM gateway sets all three.

Cost profile with routing on: a text input never touches the VLM; an image
input costs exactly two VLM calls, with extraction and all clarification
rounds on the cheaper text model. With no `LLM_VISION_*` configuration,
behavior is exactly as before — one model for everything.

The routing decision is made per call from the call's own content, so custom
`LlmClient` implementations compose the same way:
`new RoutingLlmClient({ text, vision })` accepts any two clients.

### Library use

```ts
import {
  createLlmClient, runPreprocessor, textInput, type ClarificationIO,
} from "workflow-preprocessor";

const io: ClarificationIO = {
  // Bridge to your UI: show the batch, collect answers.
  async askBatch(questions, round) {
    return { stopped: false, answers: questions.map(q => ({ questionId: q.id, answer: "…" })) };
  },
};

// createLlmClient reads LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL (plus the
// LLM_VISION_* variables, which activate vision/text routing when set); all
// of them can also be passed as options. Use `new InternalLlmClient(...)`
// directly if you never want routing.
const result = await runPreprocessor(createLlmClient(), textInput("…"), io);
switch (result.status) {
  case "validated": /* result.schema */ break;
  case "partial":   /* result.schema + result.openQuestions */ break;
  case "rejected":  /* result.reason */ break;
}
```

The pipeline never touches stdin/stdout itself — `ClarificationIO` is the
only user-interaction seam, so embedding in a web app means implementing one
method.

## Project layout

```text
preprocessor/
├── src/
│   ├── schema/
│   │   ├── workflow.ts    # graph schema, provenance, structural integrity checks
│   │   └── patches.ts     # patch ops + deterministic apply w/ provenance stamping
│   ├── pipeline/
│   │   ├── gaps.ts        # deterministic gap detection (termination condition)
│   │   ├── questions.ts   # gap -> question templates, priority, batching
│   │   ├── stages.ts      # LLM stages: triage, normalize, extract
│   │   ├── clarify.ts     # LLM stage: answers -> patches
│   │   └── run.ts         # orchestrator, state object, terminal-state guarantee
│   ├── llm/
│   │   ├── client.ts          # provider-neutral LlmClient interface + repair-loop errors
│   │   ├── internalClient.ts  # OpenAI-compatible internal-endpoint client + repair loop
│   │   ├── routingClient.ts   # vision/text routing + createLlmClient factory
│   │   ├── prompts.ts         # system prompts + intermediate format spec
│   │   └── probe.ts           # --check connectivity/config probe + diagnosis
│   ├── io/
│   │   ├── input.ts       # file/folder/stdin/clipboard loading, content sniffing
│   │   ├── clipboard.ts   # cross-platform clipboard (macOS/Windows/Linux)
│   │   └── env.ts         # .env discovery and parsing (env vars win)
│   ├── cli.ts             # readline CLI
│   └── index.ts           # public API
├── test/                  # vitest unit tests (pure code only — no network)
├── examples/              # sample inputs: rich, thin, and non-workflow
├── inbox/                 # drop folder (gitignored except its README.txt)
├── results/               # inbox output (gitignored)
├── Process workflows.command  # double-clickable launcher (macOS)
├── Process workflows.bat      # double-clickable launcher (Windows)
├── .env.example           # copy to .env and fill in
├── .gitattributes         # keeps .bat CRLF and .command LF on checkout
└── README.md
```

## Testing

`npm test` runs entirely offline. It covers the deterministic core
exhaustively — every gap detector (including SCC cycle analysis and the
suppression rules), patch application, provenance stamping, question
ordering, graph integrity — plus the full orchestrator against a stubbed
`LlmClient` (all three terminal states), the internal-endpoint client
against a stubbed `fetch` (wire format, auth, JSON validation, the repair
loop, refusal/truncation mapping, retries), and the vision/text routing
(dispatch, env/option resolution, fallbacks).

It also covers the input layer end to end without touching a network: magic-byte
modality detection for every supported format, path cleanup for dragged and
quoted paths, stdin (chunked, empty, image and text), folder discovery, `.env`
parsing and precedence, and the diagnosis each `--check` failure maps to.

## Extending

- **Downstream matching** (out of scope here) should consume the `validated`
  or `partial` result JSON; `provenance` tells it which fields are
  input-grounded vs. user-supplied, and `openQuestions` tells it exactly what
  is still unknown.
- **New gap detectors**: add a variant to `Gap`, a detector in `detectGaps`,
  a priority + template in `questions.ts`, and unit tests. Nothing else needs
  to change — the loop's termination condition picks it up automatically.
- **New patch ops**: extend `PatchSchema` + `applyPatches` (+ tests) and
  describe the op in `APPLY_ANSWERS_SYSTEM`.
