# workflow-recommender

Consumes a preprocessed workflow schema (the JSON `workflow-preprocessor`
writes) and produces a **ranked, explainable list of improvement
opportunities** — AI and non-AI alike — by matching the workflow's steps and
multi-step shapes against a deterministic pattern catalog.

This folder is self-contained and is a sibling of `preprocessor/`; nothing
here assumes it owns the repository root. The preprocessor is consumed as a
`file:` dependency for its types, LLM client, env loading, and terminal IO —
the recommender ships zero LLM plumbing of its own.

```
preprocessor result JSON        recommender
┌──────────────────────┐   ┌────────────────────────────────────────────────┐
│ validated | partial  │──▶│ load ─▶ eligibility ─▶ PROFILE (the only LLM   │
│ (rejected ─▶ ✘)      │   │ call) ─▶ provenance ─▶ ┌───────────────────┐   │
└──────────────────────┘   │                        │ gap detection      │   │
                           │              ┌────────▶│ questions (batch)  │   │
                           │              │         │ answers (no LLM)   │   │
                           │              └─────────└───────────────────┘   │
                           │  gaps == [] or user stops / cap                │
                           │        ─▶ motifs ─▶ catalog match ─▶           │
                           │           sensitivity filter ─▶ score/rank    │
                           └────────────────────────────────────────────────┘
                                             │
                              <stem>.recommendations.json
```

## Quick start

```
npm run setup          # builds ../preprocessor, then installs this package
npm run check          # verify LLM_ENDPOINT / LLM_MODEL (probe, no real run)
npx tsx src/cli.ts examples/re-knowledge-pipeline.result.json
```

Configuration is identical to the preprocessor (`LLM_ENDPOINT`,
`LLM_API_KEY`, `LLM_MODEL`, via env or the nearest `.env`); one `.env` at the
repo root serves both components. The end-to-end path is:

```
workflow-preprocessor examples/re-knowledge-pipeline.txt --out re.json
workflow-recommender  re.json                    # writes re.recommendations.json
workflow-narrator     re.recommendations.json    # writes re.report.md (see ../narrator)
```

The result JSON is the contract; the next stage, `../narrator`, turns it
into a human-readable report (deterministic body + model-written summary).

## The contract

Mirrors the preprocessor's design discipline:

1. **Exactly one of three terminal states.**
   `recommended` (every attribute gap closed) · `partial` (recommendations
   still produced — unknowns scored conservatively, confidence lowered, and
   the remaining questions listed) · `unsuitable` (rejected input, no
   task/decision steps, or profiling failed before any profile existed).
   Unlike the preprocessor, **gaps never block the result** — `partial`
   carries the same fully ranked body, just honestly hedged.

2. **One LLM stage; everything else is code.** The single `profiling` call
   classifies each task/decision node into a closed 26-class taxonomy and
   proposes attribute estimates. Gap detection, questions, answer parsing
   (multiple choice — no LLM on the way back), motif detection, matching,
   scoring, ranking: plain, unit-tested code. The model emits proposals;
   deterministic code validates and decides.

3. **Never guess.** An attribute the step text doesn't state or strongly
   imply stays `null`; the clarification loop asks, and unanswered unknowns
   substitute CONSERVATIVELY (lowest ordinal; sensitivity → `regulated`),
   each substitution named in `confidenceReasons`.

4. **Provenance drives confidence.** The preprocessor's
   `original | user_elicited` grows a third value here: `inferred` (the
   model's estimate from the wording). `high` confidence needs everything
   score-relevant grounded or user-confirmed; `inferred` values cap at
   `medium`; substitutions or inherited open questions mean `low`.

## Per-task attributes

| attribute         | scale (low → high)                                              | role |
|-------------------|-----------------------------------------------------------------|------|
| `frequency`       | ad_hoc · monthly · weekly · daily · many_per_day                | impact |
| `duration`        | under_5_min · 5_to_30_min · 30_min_to_2_h · 2_h_to_1_day · multi_day | impact |
| `structure`       | case_by_case · guidelines_with_exceptions · mostly_rules · fully_rule_based | feasibility |
| `judgment`        | expert · experienced · routine · none (inverted: higher = easier) | feasibility |
| `dataSensitivity` | public · internal · confidential · regulated                    | **hard filter** |
| `actorKind`       | human · system · ai_agent · mixed                               | motifs + AI gating |
| `errorProneness`  | rare · occasional · frequent (optional — never a question)      | impact bonus |

Data sensitivity is usually uniform across a workflow, so when two or more
steps are missing it, ONE workflow-level question is asked first and its
answer fills every step still unknown; skipping it falls back to per-step
questions the next round.

## Motifs

Multi-step shapes detected by pure graph code (cycle-safe; the graph is
never assumed acyclic). A step with unknown class/actor never qualifies.

| motif                        | fires when |
|------------------------------|------------|
| `manual_data_transfer_chain` | ≥2 connected human data-handling steps (re-keying between systems) |
| `approval_chain`             | 2+ approvals within 3 hops with no approval between |
| `notification_tail`          | a notification whose entire onward flow only notifies/files/ends |
| `repeated_similar_tasks`     | ≥2 steps sharing (class, actor) — adjacency not required |
| `long_manual_chain`          | ≥3 same-actor human tasks in an unbranching run |
| `rework_loop`                | a cycle containing a review/verification/evaluation step |

## Scoring

Every number is traceable: nothing reaches `total` without appearing by name
in `score.factors`, and the explanation is templated from those values plus
their provenance.

```
impact      = min(frequency × duration + errorBonus, 25) / 25
feasibility = clamp01(base + wS·(structure−1)/3 + wJ·(judgment−1)/3)
constraint  = effortFactor × sensitivityFriction × sequenceDiscount
total       = round(100 × impact × feasibility × constraint)
```

`(base, wS, wJ)` come from the catalog entry. **Sensitivity hard-filters
variants first**: a variant whose `sensitivityCeiling` is below the target's
sensitivity is dropped, and a pattern losing every variant lands in
`excluded` with the reason — a `regulated` step can still get AI assistance,
but only the on-prem variant survives. Ordered sequences ("first standardize
the inputs, then automate extraction") are emitted when a pattern fails ONLY
its structure gate and an applicable pattern on the same target raises
structure far enough.

## Result JSON (abridged)

```jsonc
{
  "status": "recommended",            // or "partial" (+reason, openQuestions) | "unsuitable" (+reason)
  "source": { "path": "re.json", "preprocessStatus": "validated" },
  "workflowName": "RE knowledge pipeline",
  "profiles": [ /* per-node taskClass + attributes, each {value, basis, evidence} */ ],
  "skippedNodes": [],                 // null-typed nodes in partial inputs
  "motifs": [ { "id": "motif.rework_loop:distill,expose,…", "kind": "rework_loop", /* … */ } ],
  "opportunities": [                  // ranked best-first, deterministically
    {
      "id": "pat.eval_harness_automation@verify",
      "target": { "kind": "node", "nodeId": "verify" },
      "patternId": "pat.eval_harness_automation",
      "sequence": [ { "order": 1, "patternId": "pat.eval_harness_automation" } ],
      "variants": [ /* sensitivity-filter survivors, lowest effort first */ ],
      "score": { "impact": 0.5, "feasibility": 0.71, "constraint": 0.85, "total": 30,
                 "factors": { "frequency": 4, "duration": 3, /* … every input, named */ } },
      "confidence": "medium",
      "confidenceReasons": [ "5 value(s) inferred from the step text rather than stated" ],
      "affectedBy": [],               // inherited preprocessor question ids touching this target
      "explanation": "…deterministically templated, quoting values and provenance…",
      "adviceRefs": []                // reserved for the lessons-learned component
    }
  ],
  "excluded": [ { "patternId": "pat.ai_drafting_assist", "target": { /*…*/ },
                  "reason": "all variants exceed data sensitivity regulated" } ],
  "provenance": { "profile.verify.attr.frequency": "user_elicited", /* … */ },
  "inputProvenance": { /* the preprocessor's map, echoed untouched */ },
  "rounds": [ /* full clarification audit trail */ ],
  "inheritedOpenQuestions": []
}
```

## The pattern catalog

`src/catalog/patterns.ts` is pure data — growing the catalog means appending
an entry; matching/scoring never change, and a test validates the file
against the schema. The starter set spans:

- **Non-AI first**: eliminate, consolidate (duplicates, approvals), batch,
  standardize inputs, template documents, rule-based automation, system
  integration / RPA, self-service intake, delegate.
- **AI adoption**: extraction/review assist and automate, drafting assist,
  classification & routing, QA pre-check, summarized monitoring, agent-run
  chains. All gated to `actorKinds: [human, mixed]` — the recommender never
  proposes adding AI to a step an AI agent already performs.
- **Knowledge work**: automated source monitoring, RAG knowledge bases,
  eval-harness automation — for research/engineering pipelines, including
  steps whose actor is already an AI agent.

Every entry has a stable `pat.*` id and an empty `advice` slot: the keying
surface for the planned lessons-learned component.

## CLI

```
workflow-recommender <result.json | folder> [options]
  --out <file> | --out-dir <dir>   default: <stem>.recommendations.json next to the input
  --check                          probe the LLM configuration and exit
  --max-rounds <n>                 clarification round cap (default 10)
  --no-interactive                 skip questions; unknowns scored conservatively
  --endpoint / --model / --env <f> / --no-env
Exit codes: 0 recommended · 2 partial · 3 unsuitable · 1 error
```

Folder mode processes every `*.json` except `*.recommendations.json` (so
re-runs never consume their own output) and prints a `✔ ◐ ✘` summary with
the worst status as the exit code.

## Testing

`npm test` — vitest, entirely offline. LLM-touching tests use a `FakeLlm`
stub that parses canned fixtures through the real Zod schema and the real
semanticCheck, proving fixtures are shaped like legal model output. The
deterministic core (gaps, questions, answers, motifs, matching, scoring) is
pure-function tested, including the sample-domain end-to-end expectations in
`test/run.test.ts`.
