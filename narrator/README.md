# workflow-narrator

Consumes the recommender's result JSON (`<stem>.recommendations.json`) and
writes a **coherent, human-readable report** — a Markdown document whose
body is rendered deterministically from the result, with a **model-written
summary** on top.

This folder is self-contained and is a sibling of `preprocessor/` and
`recommender/`; nothing here assumes it owns the repository root. Both
siblings are consumed as `file:` dependencies — the preprocessor for the LLM
client, env loading, and workflow types; the recommender for its result
types, vocabularies, and the pattern catalog — so the narrator ships zero
LLM plumbing of its own.

```
recommender result JSON             narrator
┌────────────────────────┐   ┌──────────────────────────────────────────────┐
│ recommended | partial  │──▶│ load ─▶ find step names ─▶ RENDER BODY       │
│ (unsuitable ─▶ notice) │   │ (deterministic) ─▶ SUMMARY (the only LLM     │
└────────────────────────┘   │ call; grounded against the body; falls back  │
     + <stem>.json           │ to a deterministic summary) ─▶ assemble      │
       (step names)          └──────────────────────────────────────────────┘
                                                  │
                                          <stem>.report.md
```

## Quick start

```
npm run setup          # builds ../preprocessor and ../recommender, then installs this package
npm run check          # verify LLM_ENDPOINT / LLM_MODEL (probe, no real run)
npx tsx src/cli.ts examples/re-knowledge-pipeline.recommendations.json
npx tsx src/cli.ts examples --no-llm     # every *.recommendations.json, no model summary
```

Configuration is identical to the siblings (`LLM_ENDPOINT`, `LLM_API_KEY`,
`LLM_MODEL`, via env or the nearest `.env`); one `.env` at the repo root
serves all three. With `--no-llm` no configuration is needed. The end-to-end
path is:

```
workflow-preprocessor examples/re-knowledge-pipeline.txt --out re.json
workflow-recommender  re.json                    # writes re.recommendations.json
workflow-narrator     re.recommendations.json    # writes re.report.md
```

`examples/` holds both inputs (`*.json` from the preprocessor,
`*.recommendations.json` from the recommender) and the reports the
deterministic layer produces for them (`*.report.md`, written with `--no-llm`).

## The contract

Mirrors the siblings' design discipline:

1. **Exactly one of three terminal states.**
   `complete` (the report is whole: a model summary on top of the
   deterministic body, or the deterministic summary when `--no-llm` asked
   for none) · `fallback` (a model was given but its summary was unavailable
   — declined, repeatedly ungrounded, endpoint error — so the deterministic
   summary stands in, with the reason recorded) · `notice` (the recommender
   result was `unsuitable`; the report explains why and what to do next).
   **The deterministic body is never lost**: the model layer can only add.

2. **One LLM stage; everything else is code.** The body — every step,
   shape, recommendation, score, exclusion, and open question — is
   templated from the result and the pattern catalog. The single `summary`
   call receives that body verbatim and returns five slots (headline,
   overview, takeaways, first step, caveats) as structured output.

3. **Never add.** The upstream stages' rule is *never guess*; the summary's
   is its mirror image. The body is the ground truth and the model may only
   condense it. The checkable part is enforced client-side as a
   `semanticCheck`, so violations go through the client's repair loop, never
   into a report: a cited score must be one a recommendation actually has
   (`NN/100`, in either wording), internal ids (`pat.*`, `motif.*`) are
   rejected, headings are rejected, and the overview stays under 250 words.

4. **Provenance stays visible.** Every quoted value carries the
   recommender's provenance: unmarked = stated in the input, `*` = inferred
   by the model from the wording, `†` = confirmed by the user. Confidence
   levels and every `confidenceReasons` entry are printed with the
   recommendation they belong to, and the recommender's own templated
   explanation is quoted verbatim as the audit trail for each score.

5. **Honest about missing context.** Step names come from the preprocessor
   result the recommender consumed (`--workflow`, the result's
   `source.path`, or the sibling `<stem>.json`). When none is found the
   report says so in its title line and refers to steps by id; an
   auto-discovered file that does not contain the profiled steps is
   discarded, not used.

## The report

```
# Improvement report — <workflow>
Source · recommender status · preprocessor status · where step names came from

## Summary                       model-written (labelled), or deterministic (labelled, with the reason)
   headline · overview · key takeaways · suggested first step · caveats

## The workflow at a glance      one sentence per step, in flow order, with provenance marks;
                                 branches and loops from the graph
## Shapes worth attention        motifs, glossed, with their member steps
## Recommendations               top N written up in full (default 5; --top):
   score · confidence · kind · effort / where / what the pattern is /
   two-step sequences / what to do (best deployment option, alternatives) /
   why it ranks here (the recommender's explanation, verbatim) /
   before starting (prerequisites, caveats) / confidence reasons /
   open preprocessor questions touching the target
   + a table of the remaining opportunities
## Ruled out by data sensitivity the excluded list, with reasons
## Open questions                partial results: the attribute questions still open;
                                 inherited preprocessor questions
## Appendix                      how to read the scores · step profile table · clarification history
```

An `unsuitable` input produces the title, a "Nothing to recommend on"
section with the recommender's reason, and next-step advice keyed on it —
and no model call, since there is nothing to summarize.

## The model summary

The model sees exactly the body the reader gets, plus the workflow name,
status, and the list of scores best-first. It is asked to lead with what
matters, in plain language, for the person who runs the workflow; to be
explicit about inferred values, low confidence, open questions, and
exclusions; and to name one concrete first step. Its output is validated
(Zod schema + grounding check) and rendered under a line that says it was
model-written and checked; the deterministic fallback is rendered under a
line that says why it is standing in. Both fill the same five slots, so the
report's shape never depends on whether the model answered.

## CLI

```
workflow-narrator <recommendations.json | folder> [options]
  --out <file> | --out-dir <dir>   default: <stem>.report.md next to the input
  --workflow <file>                the preprocessor result with the step names
                                   (default: source.path, else <stem>.json next to the input)
  --top <n>                        opportunities written up in full (default 5)
  --no-llm                         deterministic report only
  --check                          probe the LLM configuration and exit
  --endpoint / --model / --env <f> / --no-env
Exit codes: 0 complete · 2 fallback · 3 notice (unsuitable input) · 1 error
```

Folder mode processes every `*.recommendations.json` and prints a `✔ ◐ ✘`
summary with the worst status as the exit code.

## Library

```ts
import { createLlmClient } from "workflow-preprocessor";
import { narrate, workflowFromPreprocessResult } from "workflow-narrator";

const narration = await narrate(
  createLlmClient(),          // or null for the deterministic report alone
  recommendationsJson,
  { workflow: workflowFromPreprocessResult(preprocessorJson), top: 5 },
);
narration.status;   // "complete" | "fallback" | "notice"
narration.report;   // the Markdown document
narration.body;     // the deterministic sections — exactly what the model was shown
narration.summary;  // { kind: "model" | "deterministic", headline, overview, … }
```

## Testing

`npm test` — vitest, entirely offline. Fixtures are produced by running the
REAL recommender pipeline (its deterministic core plus a stubbed profiling
call) over small workflows and round-tripping the result through JSON, so
the narrator is tested against genuine recommender output. The model stage
uses the shared `FakeLlm` convention (canned output parsed through the real
Zod schema and the real grounding check), and the orchestration tests cover
every terminal state and every fallback trigger.
