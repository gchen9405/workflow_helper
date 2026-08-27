# workflow-narrator

Consumes the recommender's result JSON (`<stem>.recommendations.json`) and
writes a **coherent, human-readable report** — a Markdown document whose
body is rendered deterministically from the result, with a **model-written
summary** on top.

The report is written for the person who owns the workflow, not for the
pipeline: decisions first, evidence after. It is **layered**, not
abridged — a plain-language decision layer on top, the complete audit trail
collapsed underneath it (see [Two layers](#two-layers)).

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
   rejected, the score arithmetic (`impact 0.44`, `feasibility 0.683`) is
   rejected as unreadable in a section written for a non-technical reader,
   headings are rejected, and the overview stays under 200 words.

4. **Collapse, never delete.** Shortening is a matter of ORDER and
   VISIBILITY, never of dropping a figure. Every value the decision layer
   abbreviates is printed in full in the audit layer, every value that *is*
   quoted still carries its provenance mark (unmarked = stated in the input,
   `*` = inferred by the model from the wording, `†` = confirmed by the
   user), and the recommender's own templated explanation is still quoted
   verbatim under each recommendation. A reader can always re-derive any
   rating from the same document.

5. **Honest about missing context.** Step names come from the preprocessor
   result the recommender consumed (`--workflow`, the result's
   `source.path`, or the sibling `<stem>.json`). When none is found the
   report says so in its title line and refers to steps by id; an
   auto-discovered file that does not contain the profiled steps is
   discarded, not used. The title line carries exactly the two facts that
   colour how the *whole* report reads — a partial analysis, and missing
   step names — and nothing else; the file names and upstream statuses live
   in the appendix, where the auditing reader looks for them.

## Two layers

Both layers are deterministic; they differ in who reads them.

| | Decision layer | Audit layer |
|---|---|---|
| **Reader** | the workflow's owner, deciding | anyone checking the reasoning |
| **Where** | title line, "Where to start", the plain half of each recommendation, the trimmed step list | the `<details>` block under each recommendation, and the appendix |
| **Says** | what to change, where, how big, how sure | the score arithmetic verbatim, confidence reasons, every attribute of every step, how the report was produced |
| **Wording** | plain: `Promising (20/100)`, `no AI — a script does it`, `Runs daily, 5–30 minutes each time` | faithful: `impact 0.44 × feasibility 0.683 × constraint 0.68`, `guidelines_with_exceptions` rendered as written |

**Rating bands** (`Strong candidate` ≥ 35 · `Promising` 20–34 · `Worth a
look` 10–19 · `Low priority` < 10) are the one derived value in the report:
a fixed, documented reading of the 0–100 score, identical in every report,
printed in the appendix, and never shown without the raw score beside it.

The step list shows what drives a rating — what kind of work it is, who does
it, how often, how long — and then only what is *notable* about the rest
(sensitive data, known errors, expert judgment, case-by-case handling). The
appendix table still carries all seven attributes for every step.

## The report

```
# Improvement report — <workflow>
what the document is · partial analysis? · step names missing?

## Summary                       model-written (labelled), or deterministic (labelled, with the reason)
   headline · overview · key takeaways · suggested first step · caveats
   (four slots, four different facts — the takeaways describe the SET,
    not the ranking the table below already gives)

## Where to start                every opportunity, ranked, as one scannable table:
                                 what to change / where / how promising / effort / how sure
## The recommendations           top N written up in full (default 5; --top):
   rating band + score · effort · what kind of change · how sure /
   where / why it helps / two-step sequences / what to do (best option,
   then the alternatives) / before starting (prerequisites, caveats)
   ▸ How this was rated, and how sure we are          ← collapsed
     the recommender's explanation verbatim · confidence reasons ·
     open preprocessor questions touching the target
## How the workflow runs today   one line per step, in flow order, with provenance marks:
                                 what it is, who does it, how often, how long,
                                 then only what is notable; branches and loops
## Shapes worth attention        motifs, glossed, with their member steps
## Ruled out by data sensitivity the excluded list, with reasons
## Open questions                partial results: the attribute questions still open;
                                 inherited preprocessor questions
## Appendix
   ### How this report made      source file · both statuses · step-name origin ·
                                 clarification history
   ▸ How to read the ratings     band thresholds · the score legend      ← collapsed
   ▸ The full step profiles      every attribute of every step, with     ← collapsed
                                 provenance marks
```

An `unsuitable` input produces the title, a "Nothing to recommend on"
section with the recommender's reason, next-step advice keyed on it, and the
provenance appendix — and no model call, since there is nothing to
summarize.

`<details>` blocks render as click-to-expand on GitHub, in VS Code's
preview, and in most Markdown viewers; anywhere else they degrade to visible
text, so no content is ever unreachable.

## The model summary

The model sees exactly the body the reader gets, plus the workflow name,
status, and the list of scores best-first. It is asked to lead with what
matters for the person who runs the workflow, and to prefer plain language
to completeness — everything it leaves out is still written down below it.
It must be explicit about inferred values, low confidence, open questions,
and exclusions, and must name one concrete first step. Its output is
validated (Zod schema + grounding check) and rendered under a line that says
it was model-written and checked; the deterministic fallback is rendered
under a line that says why it is standing in. Both fill the same five slots,
so the report's shape never depends on whether the model answered.

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
