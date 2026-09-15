# workflow-pipeline

The **end-to-end entry point**: a flowchart image or a free-text process
description goes in; the narrator's human-readable improvement report comes
out — with the preprocessor's workflow schema and the recommender's ranked
opportunities alongside it, so a caller that wants to show more than the
report can.

This folder is self-contained and is a sibling of `preprocessor/`,
`recommender/` and `narrator/`; nothing here assumes it owns the repository
root. All three are consumed as `file:` dependencies, and the pipeline ships
no LLM plumbing, no scoring, and no rendering of its own: it is the wiring,
plus the one thing the wiring needs — a single user-interaction seam that
both clarification loops share.

```
                       workflow-pipeline
┌─────────────────────────────────────────────────────────────────────────┐
│  input ──▶ PREPROCESS ──▶ RECOMMEND ──▶ NARRATE ──▶ PipelineResult      │
│  image     workflow       ranked         Markdown      .status          │
│  | text    schema         opportunities  report        .report          │
│                                                        .preprocess      │
│   validated ─────▶ recommended ─────▶ complete         .recommendation  │
│   partial ───────▶ partial ─────────▶ complete         .narration       │
│   rejected ──────▶ unsuitable ──────▶ notice                            │
│                                                                         │
│   questions?  ◀── askBatch(questions, round, stage) ──▶  one IO seam     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Quick start

```sh
cd pipeline
npm run setup            # builds ../preprocessor, ../recommender, ../narrator; installs this package
cp .env.example .env     # or use one .env at the repo root — it serves all four components
npm run check            # verifies LLM_ENDPOINT / LLM_MODEL with a trivial round trip

npx tsx src/cli.ts ../preprocessor/examples/order-fulfillment.txt   # → order-fulfillment.report.md next to it
npx tsx src/cli.ts --text "A new order comes in. Sales checks it, then …"
npx tsx src/cli.ts ~/Desktop/flowchart.png --json result.json
```

The clarifying questions happen right in the terminal, first about the
workflow's structure (free text), then about each step (multiple choice —
answer with the option number). Press **Enter** to skip a question, type
**`stop`** to finish with what has been gathered, or pass `--no-interactive`
to ask nothing at all.

## The drop folder (no typing)

For anyone who should not have to touch a terminal command: drag files into
`inbox/`, then double-click the launcher for your platform. It opens a
terminal/console window, so the clarifying questions still happen right
there.

```text
pipeline/
├── Make improvement reports.command   ← double-click this on macOS
├── Make improvement reports.bat       ← double-click this on Windows
├── inbox/                             ← drag images or .txt/.md descriptions here
│   ├── README.txt                     (instructions, skipped as an input)
│   └── processed/                     (consumed inputs are moved here)
└── reports/                           ← one <name>.report.md per input
```

On Linux, `npm run inbox` does the same thing.

On first run the launchers install and build everything (`npm run setup`)
and, when no `.env` exists here or at the repo root, create one from
`.env.example` and offer to open it. Nothing is overwritten: dropping
`flow.png` twice keeps both `processed/flow.png` and `processed/flow-2.png`,
with reports in `flow.report.md` and `flow-2.report.md`.

The same thing from a terminal, with `--keep` to leave inputs in place:

```sh
npm run inbox
npx tsx src/cli.ts --inbox --keep
```

## The guarantee

The chain is *total*: every stage accepts every terminal state of the stage
before it, so **every input reaches a report**, and the pipeline's status is
the narrator's:

| Status     | Meaning                                                                                              |
|------------|------------------------------------------------------------------------------------------------------|
| `complete` | A whole report — a model-written summary on the deterministic body, or the deterministic summary when none was requested. |
| `fallback` | A whole report whose model summary was unavailable (declined, ungrounded, endpoint error); the deterministic summary stands in and says why. |
| `notice`   | Nothing to recommend on — the input was not a workflow, or had no task/decision steps. The report says why and what to do next. |

Partial upstream states — a schema with open questions, recommendations
with unknown attributes — still yield `complete`: the report is whole, opens
with "**This analysis is partial**", and lists the open questions. The
result carries each stage's own status (`preprocess.status`,
`recommendation.status`, `narration.status`) so a caller reads them
directly rather than parsing the report.

What is *not* a terminal state: an unreachable endpoint, an HTTP error after
the client's own retries, a clarification channel that rejects, a bug.
Those throw `PipelineStageError` — the pipeline never fabricates a report it
did not produce — naming the stage and carrying every result produced
before it, so a caller can show what was learned or retry from there.

Everything else is inherited unchanged from the components: extraction
never guesses; gap detection is deterministic code and terminates both
loops; every value in the report is traceable to the result it came from.

## CLI

```
workflow-pipeline --inbox                    everything dropped in inbox/ (see below)
workflow-pipeline <file>                     image or text; modality detected from content
workflow-pipeline <folder> --out-dir <d>     every input in the folder
workflow-pipeline --text "<description>"     inline text
workflow-pipeline --clipboard                image or text from the clipboard
cat notes.md | workflow-pipeline             piped stdin (or an explicit "-")

  --inbox                 Process everything in inbox/ into reports/
  --keep                  In inbox mode, do not move inputs to inbox/processed/
  --out <file>            Write the report here ("-" for stdout). Default: <stem>.report.md
                          next to a file input; stdout for --text, --clipboard and stdin
  --out-dir <dir>         Write one <name>.report.md per input (required for folders)
  --json <file>           Also write the full result — report, workflow schema,
                          recommendations, every stage's status — as JSON (single input only)
  --top <n>               Opportunities written up in full in the report (default 5)
  --max-rounds <n>        Clarification round cap, per stage (default 10)
  --no-interactive        Ask no questions; thin input yields a partial analysis
  --no-summary            Skip the model-written summary; deterministic report only
  --check                 Verify the LLM configuration and exit
  --endpoint / --model / --vision-model / --vision-endpoint / --env <f> / --no-env
Exit codes: 0 complete · 2 fallback · 3 notice · 1 error
```

Folder and inbox runs process every image and text file found, print a
`✔ ◐ ✘` summary, and exit with the worst outcome seen (a run that threw —
endpoint down, say — beats everything and exits 1; that input is left in
the inbox to be retried). `--out-dir` runs refresh their folder on re-run;
the inbox never overwrites an earlier report.

Configuration is identical to the siblings — `LLM_ENDPOINT`, `LLM_API_KEY`,
`LLM_MODEL`, optionally the `LLM_VISION_*` split for flowchart images — via
the environment or the nearest `.env`, searching upward. A text input never
touches the vision model; an image costs exactly the preprocessor's two
image-bearing calls on it. Cost of a run: three preprocessor calls, one per
preprocessor clarification round, one profiling call, one summary call.

## Library

```ts
import { createLlmClient, runPipeline, textInput } from "workflow-pipeline";

const result = await runPipeline(createLlmClient(), textInput("A new order comes in, then …"));

result.status;                    // "complete" | "fallback" | "notice"
result.report;                    // the Markdown report
result.preprocess.status;         // "validated" | "partial" | "rejected"
result.recommendation.status;     // "recommended" | "partial" | "unsuitable"
result.narration.summary;         // { kind: "model" | "deterministic", headline, overview, … }
```

`runPipeline(llm, input, options?)`:

| Option                 | Meaning                                                                    | Default |
|------------------------|----------------------------------------------------------------------------|---------|
| `io`                   | The clarification channel (see below). Omitted → no questions are asked.   | silent  |
| `maxRounds`            | Clarification round cap, per stage                                         | 10      |
| `maxQuestionsPerRound` | Questions per round, per stage                                             | 8       |
| `summary`              | `false` skips the model summary — deterministic report only, still `complete` | `true` |
| `top`                  | Opportunities written up in full in the report                             | 5       |
| `catalog`              | Pattern catalog override, for the recommender and the report               | starter |
| `inputLabel`           | How the appendix refers to the input (a file name, say)                    | `input` |
| `onProgress`           | `(p) => void`, called at each stage's start and end (with its status)      | —       |

Inputs: `textInput(string)`, `inputFromBytes(bytes, fileName?)` (sniffs
image vs. text from the bytes — an uploaded file, a pasted screenshot; a
plain `Uint8Array`, so it works in a browser too), `loadInputFromBuffer`
(the same, for a Node `Buffer`), `loadInputFromFile(path)`,
`loadInputFromStdin()`, `loadInputFromClipboard()`. Everything a host needs
— the client factory, the inputs, the terminal IO, `.env` loading, the
probe, the error classes — is re-exported from this package, so embedding
means importing one thing.

## Embedding in a website

The pipeline was shaped for this. Three properties matter:

1. **It never touches stdin/stdout.** The one place a run needs the user is
   `PipelineClarificationIO`, a single method; everything else is a
   function call in, a plain-data result out.
2. **The result is plain JSON.** `PipelineResult` round-trips through
   `JSON.stringify` unchanged — the report string, the schema graph, the
   ranked opportunities with their score breakdowns, the questions still
   open. A front end renders whichever of those it wants; the report alone
   is enough.
3. **Every input terminates.** With no questions asked a run is bounded by
   its model calls; with questions, by the round cap. Nothing hangs on the
   user unless the transport chooses to.

That leaves one design decision: whether the site asks questions.

### Pattern A — one shot (start here)

The request carries the input; the response carries the result. No
questions are asked, so thin input yields a partial analysis — a complete
report that says what is uncertain and lists the questions that would
sharpen it. This is one `runPipeline` call in a request handler:

```ts
app.post("/report", async (req, res) => {
  const input = req.is("json") ? textInput(req.body.text) : loadInputFromBuffer(req.body);
  try {
    res.json(await runPipeline(llm, input, { inputLabel: "request body" }));
  } catch (err) {
    if (err instanceof PipelineStageError) res.status(502).json({ error: err.message, stage: err.stage });
    else res.status(400).json({ error: String(err) });
  }
});
```

Expect the request to take as long as five or six model calls; a front end
shows a spinner, or the server runs it in the background and the client
polls (Pattern B's plumbing without the questions).

### Pattern B — interactive

To ask the questions, implement `askBatch` over the site's session
transport. The pipeline calls it with the questions, the round number and
the **stage** — `"preprocess"` (free-text questions about the workflow's
structure) or `"recommend"` (multiple choice about each step; every
question carries `options`, and `isChoiceQuestion(q)` narrows the type) —
and awaits a `BatchAnswers`:

```ts
const io: PipelineClarificationIO = {
  askBatch(questions, round, stage) {
    return new Promise((resolve) => {
      session.pending = { stage, round, questions, resolve };   // the client polls / receives this
    });
  },
};
// later, when the client posts its answers:
session.pending.resolve({ stopped: false, answers: [{ questionId, answer }, …] });
```

`answer: ""` skips a question; `stopped: true` finishes the stage with what
has been gathered. Because the promise can be resolved from anywhere, the
transport is free: long polling, WebSocket, SSE, a queue. Give an abandoned
session a timeout that resolves `{ stopped: true, answers: [] }`, and the
run finishes as partial instead of living forever.

The reference server below implements both patterns in ~300 lines of
dependency-free Node — a starting point to lift the handlers from, not a
framework to adopt.

### What the server needs

- Node ≥ 18.17 and the four packages built (`npm run setup` here builds
  all of them). `dist/` is plain ESM; import `workflow-pipeline` from a
  server in this repo via `file:../pipeline`, or copy the four folders.
- `LLM_ENDPOINT` / `LLM_MODEL` (and the key) in the server's environment,
  or a `.env` it can find — never in the browser. Create the client once
  (`createLlmClient()`) and share it across requests; it holds no state.
- Report progress if the wait matters: `onProgress` fires at each stage's
  start and end ("Extracting the workflow… / Finding opportunities… /
  Writing the report…"), and a pending `askBatch` is itself a progress
  signal.
- Treat `PipelineStageError` as a 5xx: `stage` says where it failed,
  `cause` is the underlying error (`LlmHttpError` with its status, a
  network error), and `preprocess` / `recommendation` hold whatever had
  already been produced — worth showing rather than discarding.
- Render the report as Markdown. Its `<details>` blocks (the audit layer
  under each recommendation, the appendix tables) collapse in any renderer
  that supports them and degrade to visible text elsewhere.

### The reference server

```sh
npm run serve                              # http://localhost:8787 (PORT to change)

# Pattern A — one shot
curl -s localhost:8787/report -H 'content-type: application/json' \
     -d '{"text":"A new order comes in. Sales validates it. If in stock, the warehouse picks and packs it; otherwise it is backordered. Done."}' \
     | jq -r .report
curl -s localhost:8787/report -H 'content-type: image/png' --data-binary @flowchart.png | jq .status

# Pattern B — interactive
curl -s localhost:8787/runs -H 'content-type: text/plain' --data-binary @notes.txt      # → {"id":"…"}
curl -s localhost:8787/runs/$ID          # {"state":"waiting","stage":"preprocess","round":1,"questions":[…]}
curl -s localhost:8787/runs/$ID/answers -H 'content-type: application/json' \
     -d '{"answers":[{"questionId":"missing_node_label:a","answer":"Sales validates the order"}]}'
curl -s localhost:8787/runs/$ID          # … "waiting" for the recommender's questions, then {"state":"done","result":{…}}
```

`POST /report` and `POST /runs` accept JSON `{ "text": "…" }` or the raw
bytes of a text file or image (the modality is sniffed from the bytes, as
in the CLI). Runs are kept in memory; a run nobody answers for ten minutes
is finished as partial. The server is deliberately minimal — add auth,
limits and persistence before exposing it.

## Embedding in the browser

The pipeline can also run **inside the browser**, bundled into a site's
front end, with the site's backend forwarding its LLM calls. That is the
shape for a host that cannot run Node on the server: the pipeline's only
runtime needs are `fetch`, `TextDecoder` and `btoa`, and its only secret —
the LLM key — stays on the server. Nothing about the pipeline changes; the
LLM client just points at a proxy instead of the endpoint.

```
Browser                                       Backend                    LLM
workflow-helper.js ── runPipeline() ──┐
  askBatch()  → your question UI       │  POST /api/workflow-helper/llm/chat/completions
  onProgress() → your stage indicator  ├──────────────────────────────▶ proxy ──▶ /chat/completions
  InternalLlmClient(endpoint: proxy) ──┘  (same-origin cookie)          adds the key, sets the model
```

### Building the bundle

```sh
npm run setup && npm run build:browser        # → dist-browser/workflow-helper.js (+ .js.map)
node scripts/build-browser.mjs --minify        # smaller, for vendoring
```

`src/browser.ts` is the entry: `runPipeline`, `isChoiceQuestion`,
`PipelineStageError`, `STAGE_BANNERS`, `InternalLlmClient` and its error
classes, `textInput`, `inputFromBytes`, `sniffImageMediaType`, and
`displayToken`. The build is one ES2020 ES module with a banner naming the
version, commit and date, and two guards: it targets the browser, so
esbuild fails on any `node:` import (proving nothing Node-only leaked in),
and it fails if more than one copy of zod got in (each sibling has its own;
the build resolves them to one). About 700 KiB raw / 120 KiB gzipped
unminified; the pattern catalog and prompts are the bulk. The siblings
expose their browser-safe surface as `workflow-preprocessor/core` and
`workflow-narrator/core`; the recommender is browser-safe as it is.

To vendor it, copy `workflow-helper.js` and `.js.map` into the site's
source tree with a note of the commit and build command, and import it
like any module. Upgrading is rebuild, re-copy.

### The client, in the browser

```js
import { InternalLlmClient, inputFromBytes, runPipeline, textInput } from "./workflow-helper.js";

const controller = new AbortController();               // "Stop" aborts the run
const llm = new InternalLlmClient({
  endpoint: "/api/workflow-helper/llm",   // the proxy; the client appends /chat/completions
  model: "server-managed",                // required by the constructor; the proxy overrides it
  maxTokens, jsonMode,                    // what the proxy's config endpoint reports
  maxNetworkRetries: 1,
  retryableStatuses: [429, 502, 503],     // never retry the proxy's own 504 (its upstream timeout)
  timeoutMs: 150_000,                     // above the proxy's upstream timeout, so its answer arrives first
  signal: controller.signal,
  fetchImpl: (url, init) => fetch(url, { ...init, credentials: "same-origin" }),
});

const input = file ? inputFromBytes(new Uint8Array(await file.arrayBuffer()), file.name) : textInput(text);
const result = await runPipeline(llm, input, { io, onProgress, inputLabel: file?.name });
```

`io.askBatch(questions, round, stage)` renders the batch and returns a
promise the submit button resolves — the same seam as Pattern B, with the
transport being the page itself. Recommender questions carry `prompt` (the
question alone) beside `text` (the terminal form with numbered options), so
a UI renders `options` as radio buttons labelled with `displayToken(token)`
and answers with the token. Every request the client sends has exactly
`model`, `max_tokens`, `messages` and, in JSON mode, `response_format`.

### The proxy contract

One login-protected endpoint, `POST …/chat/completions`, that **rebuilds**
the upstream request rather than forwarding the client's — the client is
untrusted, and a logged-in user must not get a general-purpose LLM out of
it. In order:

1. `application/json` only (415); Content-Length within a cap, checked before
   reading the body (413).
2. Rebuild from an allow-list: `messages` — 1 to 12 items, `role` in
   system/user/assistant, `content` a string or a list of `text` /
   `image_url` parts whose url matches
   `^data:image/(png|jpeg|webp|gif);base64,…$` (never http); `max_tokens`
   clamped to the server's cap; `response_format` only
   `{"type":"json_object"}` and only when JSON mode is on. Everything else
   (`model`, `stream`, `tools`, `temperature`, …) is dropped; anything
   malformed is 400 `{"error":"invalid_request","detail":…}`.
3. Choose the target on the server: an `image_url` part → the vision
   model/endpoint/key, otherwise the main one. Set `model`.
4. Forward with the key and a timeout below the site's other timeouts.
5. Map the answer. 2xx: pass the body through unchanged. Upstream 401/403:
   **502 `llm_auth`** — never pass those through, or the browser will take
   them for its own session ending. 429: 429 with `Retry-After`. Other 4xx:
   same status, `llm_rejected`. 5xx: same status, `llm_error`. Timeout: 504
   `llm_timeout`. TLS failure: 502 `llm_tls`. Unreachable: 502
   `llm_unreachable`.
6. Log one line — target, bytes, status, latency, `finish_reason`, usage —
   and never the content or the key.

Beside it, `GET …/config` tells the page `{ enabled, maxTokens, jsonMode,
maxImageBytes, imageInput }`, and an admin-only `GET …/health` sends one
trivial completion per configured target.

`examples/browser-proxy.ts` is that contract in ~350 lines of dependency-free
Node, minus login and rate limiting (it binds to 127.0.0.1); a backend in
another language must give the same answers for the same requests.

### The demo

```sh
npm run build:browser
npm run serve:browser              # http://127.0.0.1:8788, against LLM_ENDPOINT / LLM_MODEL from .env
npm run serve:browser -- --mock    # no LLM needed: examples/mock-llm.ts answers with canned fixtures
```

`examples/browser-demo/index.html` is a framework-free page that drives
the bundle the way a site would: a text box, a file picker, paste and
drag-and-drop for images, the questions of both stages (free text; radio
buttons from `prompt` + `displayToken`), a progress list, Stop, and the
raw Markdown report. It is the smoke test the unit tests cannot be —
the browser's `fetch` refuses to be called as a method of another object,
which Node never minds — so run it in the browsers you ship to. With
`--mock`, words in the text steer the run (`thin` for questions in both
stages, `reject`, `fail`, `boom`, `slow`, `hang`), and `?text=…&auto=answer`
runs one from the URL, which is how it is driven headless:

```sh
node examples/browser-smoke.mjs                      # eight paths through headless Chrome, against the --mock proxy
node examples/browser-smoke.mjs http://127.0.0.1:8080/api/workflow-helper/    # or against another host of the page
```

That needs Node ≥ 22 and a Chrome binary (`CHROME=<path>` to override the
default location). It is not a substitute for opening the page in the
browsers you ship to, but it catches regressions without clicking.

## Project layout

```text
pipeline/
├── src/
│   ├── pipeline/run.ts        # runPipeline, the IO seam, progress, PipelineStageError
│   ├── io/clarification.ts    # stagedIO: stage banners around the siblings' terminal IO
│   ├── cliMain.ts             # the CLI
│   ├── cli.ts                 # bootstrap shim ("run npm run setup" instead of ERR_MODULE_NOT_FOUND)
│   ├── index.ts               # public API + re-exports of everything a host needs
│   └── browser.ts             # the browser entry: what the bundle exports
├── scripts/build-browser.mjs  # esbuild → dist-browser/workflow-helper.js (one zod, no node: imports)
├── examples/
│   ├── server.ts              # reference HTTP embedding (node:http, no dependencies)
│   ├── browser-proxy.ts       # reference LLM proxy + static host for the browser demo
│   ├── browser-demo/index.html# framework-free page driving the bundle
│   └── mock-llm.ts            # canned chat-completions upstream, for the demo without an LLM
├── test/                      # vitest, entirely offline (FakeLlm; the browser path replays its outputs)
├── Make improvement reports.command   # double-clickable launcher (macOS)
├── Make improvement reports.bat       # double-clickable launcher (Windows)
├── inbox/                     # drop folder (gitignored except its README.txt)
├── reports/                   # inbox output (gitignored)
├── .env.example
└── README.md
```

## Testing

`npm test` runs offline. A `FakeLlm` stands in for the endpoint across all
three components — its canned output is parsed through each stage's real
Zod schema and semantic check, the sibling convention — and the tests cover
every pipeline status, both clarification loops threaded through the one
seam (stage naming, answer application, provenance), the silent default,
the summary switch, the round cap, progress events, stage failures with
their carried results, image input, and the JSON round trip a web backend
performs. The browser entry is tested by record and replay: a fixture is
run once through the `FakeLlm`, then again through a real
`InternalLlmClient` whose `fetch` replays those outputs as chat completions,
and the two results must match while every request fits the proxy's
allow-list. A last test builds the bundle for the browser and loads it.
